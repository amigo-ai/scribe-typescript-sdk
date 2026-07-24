// Framework-agnostic Scribe streaming WebSocket API client — a plain-TS state
// machine owning the worker WebSocket transport, PCM16 send loop, control
// frames, app-level keepalive, and resumable reconnect with an audio ring
// buffer. It implements the MASTER decision-11/12 wire contract verbatim (see
// ./wire.ts).
//
// It is RECORDING-INDEPENDENT: no `getUserMedia`, no `AudioContext`, no mic. The
// caller (the phase-16 web recorder, a Node file-streamer, or a test) owns
// audio capture and pumps caller-supplied PCM16 bytes in via `sendAudio`.
//
// Auth is a purpose-built, WebSocket-only **attach ticket** (aud=scribe-streaming,
// scope scribe:streams:connect, ~5-min TTL) — NOT a raw provider JWT. The SDK
// never holds a provider credential, never mints tickets, and never talks to
// k8s; it obtains a host + ticket per (re)connect from ONE of three configured
// seams (see ScribeStreamClientOptions):
//   - connectionProvider: (sessionId) => Promise<{host, ticket, ...}>  (PREFERRED)
//         one call for both, backed by the consumer's backend calling
//         `ScribeServerClient.prepareConnection`. Re-invoked on every (re)connect.
//   - allocateProvider + ticketProvider  (split seams)
//         allocateProvider: (sessionId) => Promise<{host, expiresAt}>  and
//         ticketProvider:   (sessionId) => Promise<{ticket, expiresAt?}>,
//         backed by the backend's allocate + `grant_type=token_exchange`.
//         Re-invoked on every (re)connect (the ticket TTL ≪ a session, so a
//         reconnect must never reuse a stale ticket; a reconnect lands on a new host).
//   - host + ticket  (static, one-shot)
//         concrete values already fetched from the backend; reused verbatim on
//         reconnect (so a reconnect fails once the ticket expires).
// Ordinals are server-owned (decision 6.i): the client does no re-basing — it
// forwards onTurn by ordinal; re-delivery overwrites downstream by ordinal.

import { RECONNECT, backoffDelayMs } from './backoff'
import { normalizeTurn } from './normalize'
import type { SttTranscriptSegment } from './normalize'
import { AudioRingBuffer } from './ring-buffer'
import {
  CLIENT_FRAME,
  CLOSE_CODE,
  KEEPALIVE_INTERVAL_MS,
  SERVER_MESSAGE,
  shouldReconnect,
} from './wire'
import type { RawServerFrame } from './wire'
import { buildWsUrl } from './ws-url'

/** `WebSocket.OPEN` — the readyState value for an open socket. */
const WS_OPEN = 1

export type ScribeStreamState =
  'idle' | 'connecting' | 'streaming' | 'paused' | 'reconnecting' | 'ended' | 'failed'

/** A WebSocket-only attach ticket, as returned by {@link ScribeStreamClientOptions.ticketProvider}. */
export interface AttachTicket {
  /** The attach-ticket string, sent as the second WS subprotocol value. */
  ticket: string
  /** Optional ISO-8601 expiry (informational; the SDK always re-mints per connect). */
  expiresAt?: string
}

/** A streaming-worker allocation, as returned by {@link ScribeStreamClientOptions.allocateProvider}. */
export interface StreamAllocation {
  /** `<gameserver_name>.<scribe-actors-domain>` — the WS routing host. */
  host: string
  /** ISO-8601 expiry of the allocation. */
  expiresAt: string
}

/**
 * A resolved streaming connection — the host to attach to plus the WS-only
 * attach ticket, as returned by {@link ScribeStreamClientOptions.connectionProvider}.
 * This is exactly the browser-safe bundle a server-side `prepareConnection`
 * produces (minus `sessionId`, which the client already holds).
 */
export interface StreamConnectionInfo {
  /** `<gameserver_name>.<scribe-actors-domain>` — the WS routing host. */
  host: string
  /** WS-only attach ticket (sent as the second WS subprotocol value). */
  ticket: string
  /** Optional ISO-8601 expiry of the allocation lease (informational). */
  hostExpiresAt?: string
  /** Optional ISO-8601 expiry of the attach ticket (informational). */
  ticketExpiresAt?: string
}

/**
 * Minimal WebSocket surface the client uses. The browser `WebSocket` satisfies
 * it; tests inject a fake. (Node has no global `WebSocket` in older runtimes —
 * this keeps the client transport-agnostic.)
 */
export interface WsLike {
  readonly readyState: number
  binaryType: string
  send(data: string | ArrayBuffer): void
  close(code?: number, reason?: string): void
  addEventListener(type: string, listener: (event: unknown) => void): void
  removeEventListener(type: string, listener: (event: unknown) => void): void
}

export interface ScribeStreamClientOptions {
  /** Platform `session_id` from create-session — the attach correlation key. */
  sessionId: string
  /**
   * Resolve host + attach ticket in one call (PREFERRED). Re-invoked on every
   * (re)connect, so it always yields a fresh host + ticket. Backed by the
   * consumer's backend calling `ScribeServerClient.prepareConnection` (or an
   * equivalent allocate + `token_exchange`). Use this OR the split
   * `allocateProvider` + `ticketProvider` seams OR a static `host` + `ticket`.
   */
  connectionProvider?: (sessionId: string) => Promise<StreamConnectionInfo>
  /**
   * Mint a fresh WebSocket-only attach ticket bound to `sessionId`. Re-invoked
   * on every (re)connect. Backed by the consumer's backend doing
   * `grant_type=token_exchange`. Required (with `allocateProvider`) unless
   * `connectionProvider` or a static `host` + `ticket` is given.
   */
  ticketProvider?: (sessionId: string) => Promise<AttachTicket>
  /**
   * Allocate a streaming GameServer for `sessionId`. Re-invoked on every
   * reconnect (a new GameServer = a new host). Backed by the consumer's backend
   * calling the Scribe allocate endpoint. Required (with `ticketProvider`)
   * unless `connectionProvider` or a static `host` + `ticket` is given.
   */
  allocateProvider?: (sessionId: string) => Promise<StreamAllocation>
  /**
   * Static WS host to attach to. Use with `ticket` for a one-shot connection
   * (e.g. host + ticket already fetched from your backend). NOTE: static
   * credentials are reused verbatim on reconnect, so a reconnect will fail once
   * the ticket expires — use `connectionProvider` for a reconnect-safe stream.
   */
  host?: string
  /** Static attach ticket to attach with. Use with `host` (see its note). */
  ticket?: string
  /** A normalized transcript segment arrived. */
  onTurn?: (segment: SttTranscriptSegment) => void
  /** The state machine transitioned. */
  onStateChange?: (state: ScribeStreamState) => void
  /** A terminal error occurred (reconnect exhausted, non-recoverable close). */
  onError?: (error: Error) => void
  /** A resumable reconnect re-established the stream. */
  onReconnect?: () => void

  // --- test / runtime seams ---
  /** Build the transport. Defaults to the browser `WebSocket`. */
  webSocketFactory?: (url: string, protocols: string[]) => WsLike
  /** Backoff schedule (ms) for reconnect attempt N. Defaults to {@link backoffDelayMs}. */
  reconnectDelayMs?: (attempt: number) => number
  /** App-level keepalive interval (ms). Defaults to {@link KEEPALIVE_INTERVAL_MS}. */
  keepaliveIntervalMs?: number
}

function defaultWebSocketFactory(url: string, protocols: string[]): WsLike {
  return new WebSocket(url, protocols) as unknown as WsLike
}

/** Copy caller-supplied PCM16 into a standalone `ArrayBuffer` of exactly its bytes. */
function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof Uint8Array) {
    return data.slice().buffer as ArrayBuffer
  }
  return data
}

export class ScribeStreamClient {
  private readonly opts: ScribeStreamClientOptions
  private readonly factory: (url: string, protocols: string[]) => WsLike
  private readonly delayFor: (attempt: number) => number
  private readonly keepaliveMs: number

  private readonly ring = new AudioRingBuffer()
  private socket: WsLike | null = null
  private state: ScribeStreamState = 'idle'
  private attempt = 0
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Set when the caller ends/destroys, so the close handler never reconnects. */
  private intentionalClose = false
  private lastPongAt = 0

  constructor(opts: ScribeStreamClientOptions) {
    if (!opts?.sessionId) {
      throw new Error('sessionId is required')
    }
    // One of three connection modes must be supplied: a unified
    // connectionProvider, a static host + ticket, or the split provider seams.
    if (opts.connectionProvider !== undefined) {
      if (typeof opts.connectionProvider !== 'function') {
        throw new Error('connectionProvider must be a function')
      }
    } else if (opts.host !== undefined || opts.ticket !== undefined) {
      if (!opts.host || !opts.ticket) {
        throw new Error('both host and ticket are required for a static connection')
      }
    } else {
      if (typeof opts.ticketProvider !== 'function') {
        throw new Error('ticketProvider is required')
      }
      if (typeof opts.allocateProvider !== 'function') {
        throw new Error('allocateProvider is required')
      }
    }
    this.opts = opts
    this.factory = opts.webSocketFactory ?? defaultWebSocketFactory
    this.delayFor = opts.reconnectDelayMs ?? backoffDelayMs
    this.keepaliveMs = opts.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS
  }

  /** Current state-machine state. */
  getState(): ScribeStreamState {
    return this.state
  }

  /** Highest acked byte offset (diagnostics / tests). */
  getAckedBytes(): number {
    return this.ring.ackedBytes
  }

  /** Timestamp (ms) of the last `pong` observed, or 0. */
  getLastPongAt(): number {
    return this.lastPongAt
  }

  private setState(next: ScribeStreamState): void {
    if (this.state === next) {
      return
    }
    this.state = next
    this.opts.onStateChange?.(next)
  }

  /** Open a fresh stream: allocate + mint ticket + connect from offset 0. */
  async connect(): Promise<void> {
    this.intentionalClose = false
    this.ring.reset()
    this.attempt = 0
    this.setState('connecting')
    try {
      await this.openSocket(0, false)
    } catch (error) {
      this.fail(error)
      throw error
    }
  }

  /** Feed one caller-supplied PCM16 chunk: retain it and send now if open. */
  sendAudio(pcm16: ArrayBuffer | Uint8Array): void {
    if (this.state !== 'streaming' && this.state !== 'reconnecting') {
      return
    }
    const bytes = toArrayBuffer(pcm16)
    if (bytes.byteLength === 0) {
      return
    }
    this.ring.append(bytes)
    if (this.socket && this.socket.readyState === WS_OPEN) {
      try {
        this.socket.send(bytes)
      } catch {
        // A failed send means the socket is dropping; the close handler picks
        // up reconnect. The chunk stays in the ring buffer for resend.
      }
    }
  }

  /** Pause capture; the WS stays open (server recycles its STT socket). */
  pause(): void {
    if (this.state !== 'streaming') {
      return
    }
    this.sendControl(CLIENT_FRAME.pause)
    this.setState('paused')
  }

  /** Resume after a pause; the same WS keeps flowing. */
  resume(): void {
    if (this.state !== 'paused') {
      return
    }
    this.sendControl(CLIENT_FRAME.resume)
    this.setState('streaming')
  }

  /** Finalize: tell the worker to finalize, then close cleanly (1000). */
  end(): void {
    this.intentionalClose = true
    this.clearTimers()
    this.sendControl(CLIENT_FRAME.end)
    if (this.socket) {
      try {
        this.socket.close(CLOSE_CODE.normal)
      } catch {
        // ignore — teardown proceeds regardless.
      }
    }
    this.detachSocket()
    this.setState('ended')
  }

  /** Hard teardown (unmount) — close without finalizing, never reconnect. */
  destroy(): void {
    this.intentionalClose = true
    this.clearTimers()
    if (this.socket) {
      try {
        this.socket.close(CLOSE_CODE.normal)
      } catch {
        // ignore — teardown proceeds regardless.
      }
    }
    this.detachSocket()
    if (this.state !== 'ended' && this.state !== 'failed') {
      this.setState('idle')
    }
  }

  // --- transport ---------------------------------------------------------

  /**
   * Resolve the host + attach ticket for a (re)connect from whichever seam the
   * caller configured. A fresh ticket + host are obtained on every (re)connect
   * (the ticket TTL ~5 min ≪ a session, and a reconnect lands on a new
   * GameServer) — except in static `host` + `ticket` mode, which reuses them.
   */
  private async resolveConnection(sessionId: string): Promise<{ host: string; ticket: string }> {
    if (this.opts.connectionProvider) {
      const conn = await this.opts.connectionProvider(sessionId)
      return { host: conn.host, ticket: conn.ticket }
    }
    if (this.opts.host && this.opts.ticket) {
      return { host: this.opts.host, ticket: this.opts.ticket }
    }
    // Split-seam mode: allocate first (new host), then mint the ticket.
    const allocation = await this.opts.allocateProvider!(sessionId)
    const { ticket } = await this.opts.ticketProvider!(sessionId)
    return { host: allocation.host, ticket }
  }

  private async openSocket(resumeFromOffset: number, isReconnect: boolean): Promise<void> {
    const { host, ticket } = await this.resolveConnection(this.opts.sessionId)
    const url = buildWsUrl(host, this.opts.sessionId)

    const socket = this.factory(url, ['auth', ticket])
    socket.binaryType = 'arraybuffer'
    this.socket = socket

    socket.addEventListener('open', () => {
      if (this.socket !== socket) {
        return
      }
      // Opening frame: declare where we are so the worker re-seeds ordinals past
      // existing finals and acks from the right offset (0 on a fresh connect).
      this.sendControl(CLIENT_FRAME.resumeFrom, { acked_offset_bytes: resumeFromOffset })
      // Resend only unacked audio (empty on a fresh connect).
      if (isReconnect) {
        for (const chunk of this.ring.unacked()) {
          try {
            socket.send(chunk)
          } catch {
            break
          }
        }
      }
      this.attempt = 0
      this.startKeepalive()
      this.setState('streaming')
      if (isReconnect) {
        this.opts.onReconnect?.()
      }
    })

    socket.addEventListener('message', event => {
      if (this.socket !== socket) {
        return
      }
      this.handleMessage(event as { data: unknown })
    })

    socket.addEventListener('close', event => {
      if (this.socket !== socket) {
        return
      }
      this.handleClose(event as { code?: number })
    })

    // `error` precedes `close` for a failed connection; defer to the close
    // handler (which carries the code) rather than reconnecting twice.
    socket.addEventListener('error', () => undefined)
  }

  private handleMessage(event: { data: unknown }): void {
    const { data } = event
    if (typeof data !== 'string') {
      // Binary inbound is not part of the contract.
      return
    }
    let frame: RawServerFrame
    try {
      frame = JSON.parse(data) as RawServerFrame
    } catch {
      return
    }
    switch (frame.type) {
      case SERVER_MESSAGE.ack:
        if (typeof frame.audio_offset_bytes === 'number') {
          this.ring.ack(frame.audio_offset_bytes)
        }
        return
      case SERVER_MESSAGE.pong:
        this.lastPongAt = Date.now()
        return
      case SERVER_MESSAGE.transcriptSegment:
      case SERVER_MESSAGE.interimTranscript: {
        const segment = normalizeTurn(frame)
        if (segment) {
          this.opts.onTurn?.(segment)
        }
        return
      }
      default:
        return
    }
  }

  private handleClose(event: { code?: number }): void {
    this.stopKeepalive()
    this.detachSocket()
    if (this.intentionalClose) {
      return
    }

    const code = event.code ?? CLOSE_CODE.abnormal
    if (shouldReconnect(code) && this.attempt < RECONNECT.maxAttempts) {
      this.scheduleReconnect()
      return
    }
    if (code === CLOSE_CODE.normal) {
      // Server-initiated clean close (e.g. it finalized) — terminal, not an error.
      this.setState('ended')
      return
    }
    if (shouldReconnect(code)) {
      this.fail(new Error('Stream lost — reconnect attempts exhausted'))
    } else {
      this.fail(new Error(`Stream closed (code ${code})`))
    }
  }

  private scheduleReconnect(): void {
    this.setState('reconnecting')
    const delay = this.delayFor(this.attempt)
    this.attempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.openSocket(this.ring.ackedBytes, true).catch(error => {
        // A re-allocate / re-ticket failure: back off and retry until the
        // attempt ceiling, then surface a terminal error.
        if (this.attempt < RECONNECT.maxAttempts) {
          this.scheduleReconnect()
        } else {
          this.fail(error)
        }
      })
    }, delay)
  }

  private sendControl(type: string, extra?: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WS_OPEN) {
      return
    }
    try {
      this.socket.send(JSON.stringify({ type, ...extra }))
    } catch {
      // ignore — a broken socket is handled by the close path.
    }
  }

  private startKeepalive(): void {
    this.stopKeepalive()
    // Browser WebSocket has no ping() — send a JSON {type:"ping"} text frame to
    // reset the ALB/Envoy idle timers on the browser↔worker leg.
    this.keepaliveTimer = setInterval(() => {
      this.sendControl(CLIENT_FRAME.ping)
    }, this.keepaliveMs)
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer !== null) {
      clearInterval(this.keepaliveTimer)
      this.keepaliveTimer = null
    }
  }

  private clearTimers(): void {
    this.stopKeepalive()
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private detachSocket(): void {
    this.socket = null
  }

  private fail(error: unknown): void {
    this.clearTimers()
    this.detachSocket()
    this.setState('failed')
    this.opts.onError?.(error instanceof Error ? error : new Error(String(error)))
  }
}
