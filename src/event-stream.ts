/**
 * Header-authenticated SSE helper for the Zoom session **event stream** (phase
 * 06): `GET /v1/{workspace_id}/sessions/{session_id}/events`.
 *
 * Unlike the browser's `EventSource` (which cannot send an `Authorization`
 * header), this reads the stream off `fetch`'s `ReadableStream` body so the
 * short-lived provider Bearer token rides the request header. It:
 *   - parses `event:` / `data:` / `id:` SSE frames off the byte stream,
 *   - validates each frame into a typed {@link ZoomSessionEvent} (hand-rolled,
 *     to keep the SDK dependency-free — mirrors `wire.ts`/`normalize.ts`),
 *   - tracks the last `id:` and replays via `Last-Event-ID` on reconnect,
 *   - reconnects with the shared {@link backoffDelayMs} schedule when the stream
 *     drops before a terminal `bot_status`, and
 *   - stops after a terminal `bot_status` (`done` / `error`) or when the caller
 *     aborts.
 *
 * It is an async generator, so callers consume it with `for await`:
 *
 * ```ts
 * for await (const frame of streamSessionEvents({ baseUrl, workspaceId, sessionId, token })) {
 *   if (frame.event === 'bot_status') updateBadge(frame.data)
 * }
 * ```
 */

import { backoffDelayMs, RECONNECT } from './backoff'
import { createApiError, NetworkError } from './errors'
import type { FetchLike, TokenProvider } from './http'
import type { ZoomSessionEvent, ZoomSessionEventType } from './types'

/** The set of valid `event:` names on the stream (mirrors the OpenAPI enum). */
const EVENT_TYPES = new Set<ZoomSessionEventType>([
  'bot_status',
  'transcript_segment',
  'interim_transcript',
  'transcript_finalized',
  'ping',
])

/** Terminal `bot_status.state` values after which the server closes the stream. */
const TERMINAL_BOT_STATES = new Set(['done', 'error'])

export interface StreamSessionEventsOptions {
  /** Base URL of the Scribe API, e.g. `https://scribe.platform.amigo.ai`. */
  baseUrl: string
  /** Workspace id (the path is `/v1/{workspace_id}/sessions/{id}/events`). */
  workspaceId: string
  /** Session id to stream events for. */
  sessionId: string
  /** Bearer token (or an async supplier) carrying `scribe:sessions:read_own`. */
  token: TokenProvider
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Caller abort signal — abort to stop the stream (and any pending reconnect). */
  signal?: AbortSignal
  /** Initial `Last-Event-ID` to resume from (replays events after this id). */
  lastEventId?: string
  /**
   * Max consecutive reconnect attempts after a non-terminal drop. Defaults to
   * {@link RECONNECT.maxAttempts}. Set `0` to disable reconnect.
   */
  maxRetries?: number
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>
}

/** A raw, parsed SSE frame before validation into a {@link ZoomSessionEvent}. */
interface RawSseFrame {
  id?: string
  event?: string
  data: string
}

async function resolveToken(token: TokenProvider): Promise<string> {
  return typeof token === 'function' ? token() : token
}

/**
 * Validate a raw SSE frame into a typed {@link ZoomSessionEvent}, or `null` if
 * the frame is malformed / an unknown event (the wire is untrusted). `ping`
 * keepalives carry an empty `{}` body.
 */
export function parseZoomSessionEvent(frame: RawSseFrame): ZoomSessionEvent | null {
  const event = frame.event
  if (!event || !EVENT_TYPES.has(event as ZoomSessionEventType)) {
    return null
  }
  let data: unknown
  try {
    data = frame.data ? JSON.parse(frame.data) : {}
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null) {
    return null
  }
  return { event: event as ZoomSessionEventType, data } as ZoomSessionEvent
}

/** True once a `bot_status` frame reports a terminal state (`done` / `error`). */
function isTerminal(frame: ZoomSessionEvent): boolean {
  if (frame.event !== 'bot_status') {
    return false
  }
  const state = (frame.data as { state?: unknown }).state
  return typeof state === 'string' && TERMINAL_BOT_STATES.has(state)
}

/** A `sleep(ms)` that resolves early (without throwing) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Split accumulated SSE text into complete frames. Returns the parsed frames and
 * the leftover (incomplete) tail to carry into the next chunk. Frames are
 * separated by a blank line; `event`/`data`/`id` fields per the SSE spec
 * (multiple `data:` lines join with `\n`; lines starting with `:` are comments).
 */
function drainFrames(buffer: string): { frames: RawSseFrame[]; rest: string } {
  const frames: RawSseFrame[] = []
  // Normalize CRLF so a `\r\n\r\n` boundary splits the same as `\n\n`.
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = parts.pop() ?? ''
  for (const block of parts) {
    if (!block.trim()) {
      continue
    }
    let event: string | undefined
    let id: string | undefined
    const dataLines: string[] = []
    for (const rawLine of block.split('\n')) {
      if (!rawLine || rawLine.startsWith(':')) {
        continue
      }
      const colon = rawLine.indexOf(':')
      const field = colon === -1 ? rawLine : rawLine.slice(0, colon)
      let value = colon === -1 ? '' : rawLine.slice(colon + 1)
      if (value.startsWith(' ')) {
        value = value.slice(1)
      }
      if (field === 'event') {
        event = value
      } else if (field === 'data') {
        dataLines.push(value)
      } else if (field === 'id') {
        id = value
      }
    }
    frames.push({ event, id, data: dataLines.join('\n') })
  }
  return { frames, rest }
}

/**
 * Stream a session's Zoom lifecycle + transcript events. See the module doc for
 * the full contract. Yields validated {@link ZoomSessionEvent} frames; skips
 * malformed frames; resumes with `Last-Event-ID` across reconnects; stops after
 * a terminal `bot_status` or when `options.signal` aborts.
 *
 * Non-2xx responses throw the typed {@link createApiError} result (auth / not
 * found are not retried). A transport drop before a terminal frame triggers a
 * backoff-scheduled reconnect.
 */
export async function* streamSessionEvents(
  options: StreamSessionEventsOptions
): AsyncGenerator<ZoomSessionEvent, void, unknown> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation available; pass options.fetch')
  }
  const base = options.baseUrl.replace(/\/+$/, '')
  const url = `${base}/v1/${encodeURIComponent(options.workspaceId)}/sessions/${encodeURIComponent(
    options.sessionId
  )}/events`
  const maxRetries = options.maxRetries ?? RECONNECT.maxAttempts
  let lastEventId = options.lastEventId
  let attempt = 0

  while (!options.signal?.aborted) {
    const token = await resolveToken(options.token)
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      Authorization: `Bearer ${token}`,
      ...options.defaultHeaders,
    }
    if (lastEventId !== undefined) {
      headers['Last-Event-ID'] = lastEventId
    }

    let response: Response
    try {
      response = await fetchImpl(url, { method: 'GET', headers, signal: options.signal })
    } catch (err) {
      if (options.signal?.aborted) {
        return
      }
      if (attempt >= maxRetries) {
        throw new NetworkError(
          `Event stream request failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          { url, method: 'GET' }
        )
      }
      await delay(backoffDelayMs(attempt), options.signal)
      attempt += 1
      continue
    }

    if (!response.ok) {
      // 4xx/5xx: surface the typed error (auth/not-found are not retryable).
      const text = await response.text().catch(() => '')
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        /* keep raw text */
      }
      throw createApiError(response, body)
    }

    const body = response.body
    if (!body) {
      throw new NetworkError('Event stream response had no body', undefined, { url, method: 'GET' })
    }

    // A successful connect resets the reconnect backoff.
    attempt = 0
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let closedCleanly = false
    let terminal = false

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          closedCleanly = true
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = drainFrames(buffer)
        buffer = rest
        for (const raw of frames) {
          if (raw.id !== undefined) {
            lastEventId = raw.id
          }
          const parsed = parseZoomSessionEvent(raw)
          if (!parsed) {
            continue
          }
          yield parsed
          if (isTerminal(parsed)) {
            terminal = true
            break
          }
        }
        if (terminal) {
          break
        }
      }
    } catch (err) {
      if (options.signal?.aborted) {
        return
      }
      if (attempt >= maxRetries) {
        throw new NetworkError(
          `Event stream read failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          { url, method: 'GET' }
        )
      }
    } finally {
      await reader.cancel().catch(() => {})
    }

    if (terminal || options.signal?.aborted) {
      return
    }
    // Stream dropped before a terminal frame — reconnect (resuming from
    // `Last-Event-ID`) with backoff, unless we've exhausted the budget.
    if (closedCleanly) {
      if (attempt >= maxRetries) {
        return
      }
      await delay(backoffDelayMs(attempt), options.signal)
      attempt += 1
    }
  }
}
