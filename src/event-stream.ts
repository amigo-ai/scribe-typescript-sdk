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

/** Valid `bot_status.state` values (mirrors the `BotStatusEvent` schema enum). */
const BOT_STATES = new Set([
  'joining',
  'waiting_for_host',
  'waiting_for_participant',
  'playing_disclosure',
  'listening',
  'paused',
  'idle',
  'leaving',
  'done',
  'error',
])

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
 * Strip trailing `/` from a base URL. A linear scan rather than a
 * `replace(/\/+$/, '')` regex, whose unbounded `+` before `$` is a
 * polynomial-ReDoS shape (flagged by CodeQL `js/polynomial-redos`) on inputs
 * with long runs of slashes.
 */
function stripTrailingSlashes(input: string): string {
  let end = input.length
  while (end > 0 && input.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1
  }
  return input.slice(0, end)
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
  // Event-specific structural validation — the wire is untrusted, so a frame
  // whose payload doesn't match its declared `event` is dropped (returns null)
  // rather than yielded as a mistyped `ZoomSessionEvent`.
  const record = data as Record<string, unknown>
  if (event === 'bot_status') {
    if (typeof record.state !== 'string' || !BOT_STATES.has(record.state)) {
      return null
    }
    if (record.reason != null && typeof record.reason !== 'string') {
      return null
    }
  } else if (event === 'transcript_segment' || event === 'interim_transcript') {
    if (
      typeof record.ordinal !== 'number' ||
      typeof record.text !== 'string' ||
      typeof record.timestamp !== 'string'
    ) {
      return null
    }
    if (record.speaker != null && typeof record.speaker !== 'string') {
      return null
    }
  }
  // `transcript_finalized` / `ping` carry an empty (or open) object — no fields
  // to validate beyond it being an object.
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
  // Hold back a trailing '\r' — it may be the first half of a CRLF split across
  // chunk boundaries; converting it now could fabricate a false frame boundary.
  let working = buffer
  let heldCr = ''
  if (working.endsWith('\r')) {
    heldCr = '\r'
    working = working.slice(0, -1)
  }
  // Normalize all three SSE line terminators (`\r\n`, `\n`, bare `\r`). CRLF
  // first so it collapses to a single `\n` rather than a blank line.
  const normalized = working.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const parts = normalized.split('\n\n')
  const rest = (parts.pop() ?? '') + heldCr
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
  const resolvedFetch = options.fetch ?? globalThis.fetch
  if (typeof resolvedFetch !== 'function') {
    throw new Error('No fetch implementation available; pass options.fetch')
  }
  // Bind to globalThis: native `fetch` throws "Illegal invocation" if invoked
  // as a bare reference in browsers (same fix as HttpClient). Harmless for an
  // already-bound / arrow `options.fetch`.
  const fetchImpl = resolvedFetch.bind(globalThis)
  const base = stripTrailingSlashes(options.baseUrl)
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
    // Omit the header when the last id is unset OR empty: SSE uses an empty id
    // to RESET resume state, after which no cursor should be sent (some servers
    // reject a present-but-empty `Last-Event-ID`).
    if (lastEventId) {
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

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let terminal = false
    let hadError = false
    let readError: unknown
    let yielded = 0

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          break // clean EOF (non-terminal) — fall through to the retry gate
        }
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = drainFrames(buffer)
        buffer = rest
        for (const raw of frames) {
          // Track resume position; ignore ids containing NUL (per SSE parsing).
          if (raw.id !== undefined && !raw.id.includes('\u0000')) {
            lastEventId = raw.id
          }
          const parsed = parseZoomSessionEvent(raw)
          if (!parsed) {
            continue
          }
          yield parsed
          yielded += 1
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
      hadError = true
      readError = err
    } finally {
      await reader.cancel().catch(() => {})
    }

    if (terminal || options.signal?.aborted) {
      return
    }

    // Single retry gate for EVERY non-terminal exit (clean EOF or read error).
    // A connection that delivered ≥1 event counts as progress and resets the
    // backoff; one that produced nothing (e.g. the server accepts then
    // immediately errors the body) keeps consuming the retry budget, so the loop
    // can never spin unbounded and `maxRetries` is always honored.
    if (yielded > 0) {
      attempt = 0
    }
    if (attempt >= maxRetries) {
      if (hadError) {
        throw new NetworkError(
          `Event stream read failed: ${readError instanceof Error ? readError.message : String(readError)}`,
          readError instanceof Error ? readError : new Error(String(readError)),
          { url, method: 'GET' }
        )
      }
      return
    }
    await delay(backoffDelayMs(attempt), options.signal)
    attempt += 1
  }
}
