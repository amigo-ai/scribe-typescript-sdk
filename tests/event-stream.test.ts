/**
 * Unit coverage for the `/events` SSE helper (phase 06): header-auth `fetch`
 * streaming, frame parsing/validation, terminal-`bot_status` stop,
 * `Last-Event-ID` resume across a reconnect, and typed non-2xx errors.
 */
import { describe, expect, it } from 'vitest'
import { parseZoomSessionEvent, streamSessionEvents } from '../src/event-stream'
import { NotFoundError } from '../src/errors'
import type { FetchLike } from '../src/http'
import type { ZoomSessionEvent } from '../src/types'

const BASE = 'https://scribe.example.test'
const WS = 'ws-1'
const SID = 'sess-1'

/** Build a streaming `Response` whose body emits `chunks` then closes. */
function sseResponse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) {
        controller.enqueue(enc.encode(c))
      }
      controller.close()
    },
  })
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: new Headers(),
    body: status >= 200 && status < 300 ? stream : null,
    text: () =>
      Promise.resolve(status >= 200 && status < 300 ? '' : JSON.stringify({ message: 'x' })),
  } as unknown as Response
}

/** A fetch returning queued responses in order; records each call's headers. */
function queuedFetch(responses: Response[]): {
  fetch: FetchLike
  calls: Array<{ url: string; headers: Record<string, string> }>
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  let i = 0
  const fetch: FetchLike = (url, init) => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) {
      Object.assign(headers, h)
    }
    calls.push({ url, headers })
    const res = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return Promise.resolve(res)
  }
  return { fetch, calls }
}

async function collect(gen: AsyncGenerator<ZoomSessionEvent>): Promise<ZoomSessionEvent[]> {
  const out: ZoomSessionEvent[] = []
  for await (const ev of gen) {
    out.push(ev)
  }
  return out
}

describe('parseZoomSessionEvent', () => {
  it('parses a valid bot_status frame', () => {
    const ev = parseZoomSessionEvent({ event: 'bot_status', data: '{"state":"listening"}' })
    expect(ev).toEqual({ event: 'bot_status', data: { state: 'listening' } })
  })

  it('parses a ping keepalive with an empty body', () => {
    const ev = parseZoomSessionEvent({ event: 'ping', data: '' })
    expect(ev).toEqual({ event: 'ping', data: {} })
  })

  it('rejects an unknown event name', () => {
    expect(parseZoomSessionEvent({ event: 'nope', data: '{}' })).toBeNull()
  })

  it('rejects a malformed JSON data payload', () => {
    expect(parseZoomSessionEvent({ event: 'bot_status', data: '{not json' })).toBeNull()
  })

  it('rejects a bot_status frame with an unknown/invalid state', () => {
    expect(parseZoomSessionEvent({ event: 'bot_status', data: '{"state":"nope"}' })).toBeNull()
    expect(parseZoomSessionEvent({ event: 'bot_status', data: '{"state":123}' })).toBeNull()
  })

  it('rejects a transcript frame missing required fields', () => {
    // missing text + timestamp
    expect(parseZoomSessionEvent({ event: 'transcript_segment', data: '{"ordinal":1}' })).toBeNull()
    // ordinal wrong type
    expect(
      parseZoomSessionEvent({
        event: 'transcript_segment',
        data: '{"ordinal":"1","text":"hi","timestamp":"0"}',
      })
    ).toBeNull()
  })

  it('accepts a well-formed transcript frame', () => {
    const ev = parseZoomSessionEvent({
      event: 'transcript_segment',
      data: '{"ordinal":2,"text":"hello","timestamp":"12","speaker":"clinician"}',
    })
    expect(ev?.event).toBe('transcript_segment')
  })
})

describe('streamSessionEvents', () => {
  it('yields typed frames and stops after a terminal bot_status', async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        'event: bot_status\ndata: {"state":"joining"}\n\n',
        'event: transcript_segment\ndata: {"ordinal":1,"text":"hi","timestamp":"0"}\n\n',
        'event: bot_status\ndata: {"state":"done"}\n\n',
        // never reached — stream stops at the terminal frame above
        'event: bot_status\ndata: {"state":"listening"}\n\n',
      ]),
    ])
    const events = await collect(
      streamSessionEvents({ baseUrl: BASE, workspaceId: WS, sessionId: SID, token: 't', fetch })
    )

    expect(events.map(e => e.event)).toEqual(['bot_status', 'transcript_segment', 'bot_status'])
    expect(events[2]!.data).toEqual({ state: 'done' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/${SID}/events`)
    expect(calls[0]!.headers.Authorization).toBe('Bearer t')
    expect(calls[0]!.headers.Accept).toBe('text/event-stream')
  })

  it('skips malformed/unknown frames but keeps valid ones', async () => {
    const { fetch } = queuedFetch([
      sseResponse([
        'event: bogus\ndata: {}\n\n',
        'event: bot_status\ndata: {bad json\n\n',
        'event: bot_status\ndata: {"state":"listening"}\n\n',
        'event: bot_status\ndata: {"state":"error"}\n\n',
      ]),
    ])
    const events = await collect(
      streamSessionEvents({ baseUrl: BASE, workspaceId: WS, sessionId: SID, token: 't', fetch })
    )
    expect(events.map(e => (e.data as { state?: string }).state)).toEqual(['listening', 'error'])
  })

  it('resumes with Last-Event-ID after a non-terminal drop', async () => {
    const { fetch, calls } = queuedFetch([
      // First connection drops (clean close) without a terminal frame.
      sseResponse(['id: 42\nevent: bot_status\ndata: {"state":"listening"}\n\n']),
      // Reconnect carries Last-Event-ID: 42 and then finishes.
      sseResponse(['id: 43\nevent: bot_status\ndata: {"state":"done"}\n\n']),
    ])
    const events = await collect(
      streamSessionEvents({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        fetch,
        maxRetries: 3,
      })
    )
    expect(events.map(e => (e.data as { state?: string }).state)).toEqual(['listening', 'done'])
    expect(calls).toHaveLength(2)
    expect(calls[0]!.headers['Last-Event-ID']).toBeUndefined()
    expect(calls[1]!.headers['Last-Event-ID']).toBe('42')
  }, 10_000)

  it('throws a typed error on a non-2xx status (not retried)', async () => {
    const { fetch, calls } = queuedFetch([sseResponse([], 404)])
    await expect(
      collect(
        streamSessionEvents({ baseUrl: BASE, workspaceId: WS, sessionId: SID, token: 't', fetch })
      )
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(calls).toHaveLength(1)
  })

  it('binds fetch to globalThis (no Illegal invocation for native-like fetch)', async () => {
    const nativeLike = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(sseResponse(['event: bot_status\ndata: {"state":"done"}\n\n']))
    } as unknown as FetchLike
    const events = await collect(
      streamSessionEvents({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        fetch: nativeLike,
      })
    )
    expect(events.map(e => e.event)).toEqual(['bot_status'])
  })

  it('honors the retry budget on a body that errors with no events (no unbounded loop)', async () => {
    // A 200 whose body immediately errors, repeatedly. With maxRetries=0 the
    // stream must throw after the first failed read — never tight-loop.
    let calls = 0
    const erroringBody: FetchLike = () => {
      calls += 1
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('body boom'))
        },
      })
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: '',
        headers: new Headers(),
        body: stream,
        text: () => Promise.resolve(''),
      } as unknown as Response)
    }
    await expect(
      collect(
        streamSessionEvents({
          baseUrl: BASE,
          workspaceId: WS,
          sessionId: SID,
          token: 't',
          fetch: erroringBody,
          maxRetries: 0,
        })
      )
    ).rejects.toBeTruthy()
    expect(calls).toBe(1)
  })

  it('returns (no throw) on a clean EOF with no events when the budget is exhausted', async () => {
    let calls = 0
    const emptyThenClose: FetchLike = () => {
      calls += 1
      return Promise.resolve(sseResponse([])) // immediate clean EOF, zero frames
    }
    const events = await collect(
      streamSessionEvents({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        fetch: emptyThenClose,
        maxRetries: 0,
      })
    )
    expect(events).toEqual([])
    expect(calls).toBe(1)
  })

  it('stops when the caller aborts', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = queuedFetch([
      sseResponse(['event: bot_status\ndata: {"state":"listening"}\n\n']),
    ])
    const events = await collect(
      streamSessionEvents({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        fetch,
        signal: controller.signal,
      })
    )
    expect(events).toEqual([])
    expect(calls).toHaveLength(0)
  })
})
