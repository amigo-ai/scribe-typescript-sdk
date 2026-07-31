/**
 * Header-authenticated SSE helper for the **Ask** endpoint (phase 09):
 * `POST /v1/{workspace_id}/sessions/{session_id}/ask`.
 *
 * A generalization of the phase-06 `/events` streaming helper
 * ({@link streamSessionEvents}) to a POST-bodied SSE response. Like that helper
 * it reads the answer off `fetch`'s `ReadableStream` body (NOT `EventSource`,
 * which can neither send an `Authorization` header nor POST a JSON body), so the
 * short-lived provider Bearer token rides the request header. It:
 *   - POSTs `{ question, history? }` as JSON with `Accept: text/event-stream`,
 *   - parses `event:` / `data:` SSE frames off the byte stream,
 *   - validates each frame into a typed {@link AskStreamFrame} (`delta {text}` /
 *     `done {generation_id}`) — hand-rolled, to keep the SDK dependency-free
 *     (mirrors `event-stream.ts`/`wire.ts`),
 *   - tolerates `ping` / `:`-comment keepalives,
 *   - stops after the terminal `done` frame (or when the caller aborts), and
 *   - retries only the INITIAL connection (transport failure before any frame)
 *     with the shared {@link backoffDelayMs} schedule so a wedged provider fails
 *     fast. Unlike the resumable GET `/events` stream, a POST `/ask` is NOT
 *     replayable, so a mid-stream drop after ≥1 frame surfaces as a
 *     {@link NetworkError} rather than silently re-asking (which would duplicate
 *     deltas / re-bill the model).
 *
 * It is an async generator, so callers consume it with `for await` and read the
 * terminal `generation_id` off the final `done` frame:
 *
 * ```ts
 * let answer = ''
 * for await (const frame of askSession({ baseUrl, workspaceId, sessionId, token, question })) {
 *   if (frame.type === 'delta') answer += frame.text
 *   else console.log('done', frame.generation_id)
 * }
 * ```
 */

import { backoffDelayMs, RECONNECT } from './backoff'
import { createApiError, NetworkError } from './errors'
import type { FetchLike, TokenProvider } from './http'
import type { AskHistoryMessage } from './types'

/** A streamed answer token — appended in order to build the running answer. */
export interface AskDeltaFrame {
  type: 'delta'
  /** The next chunk of answer text. */
  text: string
}

/** The terminal frame — the answer is complete; carries its provenance id. */
export interface AskDoneFrame {
  type: 'done'
  /** Provenance id of this Q&A generation (the answer is not persisted as an artifact). */
  generation_id: string
}

/** One validated frame off the `/ask` SSE stream. */
export type AskStreamFrame = AskDeltaFrame | AskDoneFrame

export interface AskSessionOptions {
  /** Base URL of the Scribe API, e.g. `https://scribe.platform.amigo.ai`. */
  baseUrl: string
  /** Workspace id (the path is `/v1/{workspace_id}/sessions/{id}/ask`). */
  workspaceId: string
  /** Session id to ask about. */
  sessionId: string
  /** Bearer token (or an async supplier) carrying `scribe:sessions:read_own`. */
  token: TokenProvider
  /** The question to ask over the session's transcript + latest note. */
  question: string
  /** Optional prior turns for multi-turn context. */
  history?: AskHistoryMessage[]
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Caller abort signal — abort to stop the stream (and any pending reconnect). */
  signal?: AbortSignal
  /**
   * Max INITIAL-connection retry attempts on a transport failure before the
   * first frame. Defaults to {@link RECONNECT.maxAttempts}. Set `0` to disable.
   * A drop AFTER the first frame is never retried (a POST `/ask` is not
   * replayable) — it throws.
   */
  maxRetries?: number
  /** Extra headers merged into every request. */
  defaultHeaders?: Record<string, string>
}

/** A raw, parsed SSE frame before validation into an {@link AskStreamFrame}. */
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
 * polynomial-ReDoS shape (flagged by CodeQL `js/polynomial-redos`).
 */
function stripTrailingSlashes(input: string): string {
  let end = input.length
  while (end > 0 && input.charCodeAt(end - 1) === 47 /* '/' */) {
    end -= 1
  }
  return input.slice(0, end)
}

/**
 * Validate a raw SSE frame into a typed {@link AskStreamFrame}, or `null` if the
 * frame is malformed / an unknown or keepalive event (the wire is untrusted).
 * A `delta` needs a string `text`; a terminal `done` needs a string
 * `generation_id`; `ping` (and any other event) is dropped.
 */
export function parseAskFrame(frame: RawSseFrame): AskStreamFrame | null {
  const event = frame.event
  if (event !== 'delta' && event !== 'done') {
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
  const record = data as Record<string, unknown>
  if (event === 'delta') {
    if (typeof record.text !== 'string') {
      return null
    }
    return { type: 'delta', text: record.text }
  }
  // event === 'done'
  if (typeof record.generation_id !== 'string' || !record.generation_id) {
    return null
  }
  return { type: 'done', generation_id: record.generation_id }
}

/** A `sleep(ms)` that resolves early (without throwing) if `signal` aborts. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    // Call timers via `globalThis.` so the receiver is globalThis: a bare
    // `setTimeout(...)` reference throws "Illegal invocation" in browsers (same
    // class as the `fetch` bug). Property-access form also stays fake-timer safe.
    const timer = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(timer)
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
 * Stream an answer to `question` over a session's transcript + latest note. See
 * the module doc for the full contract. Yields validated {@link AskStreamFrame}s
 * (`delta` chunks then a terminal `done`); skips malformed / keepalive frames;
 * stops after `done` or when `options.signal` aborts.
 *
 * Non-2xx responses throw the typed {@link createApiError} result. A transport
 * failure BEFORE the first frame triggers a backoff-scheduled retry (up to
 * `maxRetries`); a drop AFTER the first frame throws (a POST `/ask` is not
 * replayable).
 */
export async function* askSession(
  options: AskSessionOptions
): AsyncGenerator<AskStreamFrame, void, unknown> {
  if (!options.sessionId) {
    throw new Error('sessionId is required')
  }
  if (!options.workspaceId) {
    throw new Error('workspaceId is required')
  }
  if (!options.question) {
    throw new Error('question is required')
  }
  const resolvedFetch = options.fetch ?? globalThis.fetch
  if (typeof resolvedFetch !== 'function') {
    throw new Error('No fetch implementation available; pass options.fetch')
  }
  // Bind to globalThis: native `fetch` throws "Illegal invocation" if invoked as
  // a bare reference in browsers (same fix as HttpClient / event-stream).
  // Harmless for an already-bound / arrow `options.fetch`.
  const fetchImpl = resolvedFetch.bind(globalThis)
  const base = stripTrailingSlashes(options.baseUrl)
  const url = `${base}/v1/${encodeURIComponent(options.workspaceId)}/sessions/${encodeURIComponent(
    options.sessionId
  )}/ask`
  const maxRetries = options.maxRetries ?? RECONNECT.maxAttempts
  const payload = JSON.stringify({
    question: options.question,
    ...(options.history ? { history: options.history } : {}),
  })
  let attempt = 0
  let started = false

  while (!options.signal?.aborted) {
    const token = await resolveToken(options.token)
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.defaultHeaders,
    }

    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: payload,
        signal: options.signal,
      })
    } catch (err) {
      if (options.signal?.aborted) {
        return
      }
      // A POST that never got a response can be safely retried (no frames were
      // emitted yet). Once the stream has started, `started` short-circuits this.
      if (attempt >= maxRetries) {
        throw new NetworkError(
          `Ask request failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          { url, method: 'POST' }
        )
      }
      await delay(backoffDelayMs(attempt), options.signal)
      attempt += 1
      continue
    }

    if (!response.ok) {
      // 4xx/5xx: surface the typed error (auth/not-found/validation not retried).
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
      throw new NetworkError('Ask response had no body', undefined, { url, method: 'POST' })
    }

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let terminal = false
    let readError: unknown
    let hadError = false

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) {
          break // EOF — a clean close before `done` is an incomplete answer
        }
        buffer += decoder.decode(value, { stream: true })
        const { frames, rest } = drainFrames(buffer)
        buffer = rest
        for (const raw of frames) {
          const parsed = parseAskFrame(raw)
          if (!parsed) {
            continue
          }
          started = true
          yield parsed
          if (parsed.type === 'done') {
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

    // Non-terminal exit. If any frame was emitted, the POST is NOT replayable —
    // re-asking would duplicate deltas / re-bill — so fail loudly. Only a
    // connection that produced zero frames may retry within the budget.
    if (started) {
      throw new NetworkError(
        hadError
          ? `Ask stream read failed after partial answer: ${
              readError instanceof Error ? readError.message : String(readError)
            }`
          : 'Ask stream closed before a terminal `done` frame',
        readError instanceof Error ? readError : undefined,
        { url, method: 'POST' }
      )
    }
    if (attempt >= maxRetries) {
      if (hadError) {
        throw new NetworkError(
          `Ask stream read failed: ${
            readError instanceof Error ? readError.message : String(readError)
          }`,
          readError instanceof Error ? readError : new Error(String(readError)),
          { url, method: 'POST' }
        )
      }
      throw new NetworkError('Ask stream closed before any frame', undefined, {
        url,
        method: 'POST',
      })
    }
    await delay(backoffDelayMs(attempt), options.signal)
    attempt += 1
  }
}
