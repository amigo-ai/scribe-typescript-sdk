// Browser recording layer on top of the phase-15 `ScribeStreamClient`.
//
// `ScribeRecorder` owns the mic-capture pipeline and drives the WS client:
//   start()  → client.connect() + start the mic, piping each PCM16 chunk to
//              client.sendAudio()
//   pause()  → stop the mic + client.pause()
//   resume() → client.resume() + restart the mic
//   end()    → stop the mic + client.end()
//
// It contains NO wire-protocol logic: reconnect, the audio ring buffer,
// keepalive, control-frame encoding, and attach-ticket auth all live in the
// phase-15 client. The recorder only calls the client's PUBLIC API
// (connect/sendAudio/pause/resume/end/destroy) and forwards its events, adding
// recorder-level state (mic permission + capturing) on top. On reconnect the
// mic keeps running — the client re-allocates, re-mints a ticket, and resends
// unacked audio; the recorder just keeps feeding new chunks.

import type { AudioCaptureLike, AudioCaptureMode, AudioCaptureOptions } from './audio-capture'
import { AudioCapture } from './audio-capture'
import type { SttTranscriptSegment } from './normalize'
import { ScribeStreamClient } from './stream-client'
import type { ScribeStreamClientOptions, ScribeStreamState } from './stream-client'

/** The subset of {@link ScribeStreamClient} the recorder depends on (a test seam). */
export interface ScribeStreamClientLike {
  connect(): Promise<void>
  sendAudio(pcm16: ArrayBuffer | Uint8Array): void
  pause(): void
  resume(): void
  end(): void
  destroy(): void
  getState(): ScribeStreamState
}

/** Recorder lifecycle state (coarser than the client's transport state). */
export type ScribeRecorderState = 'idle' | 'recording' | 'paused' | 'ended' | 'failed'

/** Microphone permission as observed by the recorder. */
export type MicPermission = 'unknown' | 'granted' | 'denied'

/** The recorder's aggregated status, surfaced via {@link ScribeRecorderOptions.onStateChange}. */
export interface ScribeRecorderStatus {
  /** Recorder lifecycle state. */
  state: ScribeRecorderState
  /** Underlying WS-client transport state (surfaced so consumers can observe reconnecting/etc). */
  streamState: ScribeStreamState
  /** Microphone permission as last observed. */
  micPermission: MicPermission
  /** Whether the mic tap is currently producing chunks. */
  capturing: boolean
}

/** Options passed straight through to the phase-15 client. */
type StreamClientPassthrough = Omit<
  ScribeStreamClientOptions,
  'onTurn' | 'onStateChange' | 'onReconnect' | 'onError'
>

export interface ScribeRecorderOptions extends StreamClientPassthrough {
  /** A normalized transcript segment arrived (forwarded from the client). */
  onTurn?: (segment: SttTranscriptSegment) => void
  /** The recorder's aggregated status changed. */
  onStateChange?: (status: ScribeRecorderStatus) => void
  /** A resumable reconnect re-established the stream (forwarded from the client). */
  onReconnect?: () => void
  /** A terminal error occurred (from the client or from capture). */
  onError?: (error: Error) => void

  /** Capture mode. Defaults to `'mic'`. */
  audioCaptureMode?: AudioCaptureMode
  /** ScriptProcessor buffer size (frames). Forwarded to {@link AudioCapture}. */
  audioBufferSize?: number

  // --- test seams ---
  /** Build the WS client. Defaults to `new ScribeStreamClient(opts)`. */
  clientFactory?: (opts: ScribeStreamClientOptions) => ScribeStreamClientLike
  /** Build the capture pipeline. Defaults to `new AudioCapture(opts)`. */
  captureFactory?: (opts: AudioCaptureOptions) => AudioCaptureLike
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

/** True when a `getUserMedia`/`getDisplayMedia` rejection signals denied permission. */
function isPermissionDenied(error: unknown): boolean {
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    return error.name === 'NotAllowedError' || error.name === 'SecurityError'
  }
  const name = (error as { name?: unknown })?.name
  return name === 'NotAllowedError' || name === 'SecurityError'
}

export class ScribeRecorder {
  private readonly opts: ScribeRecorderOptions
  private readonly client: ScribeStreamClientLike
  private readonly capture: AudioCaptureLike

  private state: ScribeRecorderState = 'idle'
  private streamState: ScribeStreamState = 'idle'
  private micPermission: MicPermission = 'unknown'
  private capturing = false
  private lastStatusKey = ''

  constructor(opts: ScribeRecorderOptions) {
    this.opts = opts

    const clientOptions: ScribeStreamClientOptions = {
      sessionId: opts.sessionId,
      ticketProvider: opts.ticketProvider,
      allocateProvider: opts.allocateProvider,
      webSocketFactory: opts.webSocketFactory,
      reconnectDelayMs: opts.reconnectDelayMs,
      keepaliveIntervalMs: opts.keepaliveIntervalMs,
      onTurn: segment => this.opts.onTurn?.(segment),
      onStateChange: state => this.handleClientState(state),
      onReconnect: () => this.opts.onReconnect?.(),
      onError: error => this.handleClientError(error),
    }
    const clientFactory = opts.clientFactory ?? (o => new ScribeStreamClient(o))
    this.client = clientFactory(clientOptions)

    const captureOptions: AudioCaptureOptions = {
      onChunk: pcm16 => this.client.sendAudio(pcm16),
      mode: opts.audioCaptureMode,
      bufferSize: opts.audioBufferSize,
    }
    const captureFactory = opts.captureFactory ?? (o => new AudioCapture(o))
    this.capture = captureFactory(captureOptions)
  }

  /** Current recorder lifecycle state. */
  getState(): ScribeRecorderState {
    return this.state
  }

  /** Current aggregated recorder status. */
  getStatus(): ScribeRecorderStatus {
    return {
      state: this.state,
      streamState: this.streamState,
      micPermission: this.micPermission,
      capturing: this.capturing,
    }
  }

  /** Connect the WS client and start the mic, piping PCM16 into the client. */
  async start(): Promise<void> {
    if (this.state === 'recording' || this.state === 'paused') {
      return
    }
    try {
      await this.client.connect()
      await this.startCapture()
      this.state = 'recording'
      this.emitStatus()
    } catch (error) {
      this.failFromError(error)
      throw toError(error)
    }
  }

  /** Stop the mic and pause the stream; the WS stays open. */
  pause(): void {
    if (this.state !== 'recording') {
      return
    }
    this.stopCaptureQuietly()
    this.client.pause()
    this.state = 'paused'
    this.emitStatus()
  }

  /** Resume the stream and restart the mic. */
  async resume(): Promise<void> {
    if (this.state !== 'paused') {
      return
    }
    try {
      this.client.resume()
      await this.startCapture()
      this.state = 'recording'
      this.emitStatus()
    } catch (error) {
      this.failFromError(error)
      throw toError(error)
    }
  }

  /** Finalize: stop the mic and tell the client to finalize + close cleanly. */
  end(): void {
    if (this.state === 'ended' || this.state === 'idle') {
      return
    }
    this.stopCaptureQuietly()
    this.client.end()
    this.state = 'ended'
    this.emitStatus()
  }

  /** Hard teardown — stop the mic and destroy the client without finalizing. */
  destroy(): void {
    this.stopCaptureQuietly()
    this.client.destroy()
    if (this.state !== 'ended' && this.state !== 'failed') {
      this.state = 'idle'
    }
    this.emitStatus()
  }

  // --- internals ---------------------------------------------------------

  private async startCapture(): Promise<void> {
    try {
      await this.capture.start()
      this.micPermission = 'granted'
      this.capturing = true
    } catch (error) {
      if (isPermissionDenied(error)) {
        this.micPermission = 'denied'
      }
      throw error
    }
  }

  private stopCaptureQuietly(): void {
    try {
      this.capture.stop()
    } catch {
      // ignore — teardown proceeds regardless.
    }
    this.capturing = false
  }

  private failFromError(error: unknown): void {
    this.stopCaptureQuietly()
    this.client.destroy()
    this.state = 'failed'
    this.emitStatus()
    this.opts.onError?.(toError(error))
  }

  private handleClientState(state: ScribeStreamState): void {
    this.streamState = state
    if (state === 'failed') {
      this.stopCaptureQuietly()
      this.state = 'failed'
    } else if (state === 'ended' && this.state !== 'ended') {
      // Server-initiated clean close (e.g. it finalized) — terminal for us too.
      this.stopCaptureQuietly()
      this.state = 'ended'
    }
    this.emitStatus()
  }

  private handleClientError(error: Error): void {
    this.stopCaptureQuietly()
    this.opts.onError?.(error)
  }

  private emitStatus(): void {
    const status = this.getStatus()
    const key = `${status.state}|${status.streamState}|${status.micPermission}|${status.capturing}`
    if (key === this.lastStatusKey) {
      return
    }
    this.lastStatusKey = key
    this.opts.onStateChange?.(status)
  }
}
