/**
 * Unit coverage for the `/ask` SSE helper (phase 09): header-auth `fetch`
 * streaming of a POST body, `delta`→`done` frame parsing/validation, the
 * terminal-`done` stop, typed non-2xx errors, receiver-safe (globalThis-bound)
 * fetch, and the no-replay-after-progress rule.
 */
import { describe, expect, it } from 'vitest'
import { askSession, parseAskFrame } from '../src/ask-stream'
import type { AskStreamFrame } from '../src/ask-stream'
import { NetworkError, NotFoundError } from '../src/errors'
import type { FetchLike } from '../src/http'

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

/** A fetch returning queued responses in order; records each call's url/headers/body. */
function queuedFetch(responses: Response[]): {
  fetch: FetchLike
  calls: Array<{ url: string; headers: Record<string, string>; body: unknown; method?: string }>
} {
  const calls: Array<{
    url: string
    headers: Record<string, string>
    body: unknown
    method?: string
  }> = []
  let i = 0
  const fetch: FetchLike = (url, init) => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) {
      Object.assign(headers, h)
    }
    calls.push({ url, headers, body: init?.body, method: init?.method })
    const res = responses[Math.min(i, responses.length - 1)]!
    i += 1
    return Promise.resolve(res)
  }
  return { fetch, calls }
}

async function collect(gen: AsyncGenerator<AskStreamFrame>): Promise<AskStreamFrame[]> {
  const out: AskStreamFrame[] = []
  for await (const f of gen) {
    out.push(f)
  }
  return out
}

describe('parseAskFrame', () => {
  it('parses a delta frame', () => {
    expect(parseAskFrame({ event: 'delta', data: '{"text":"Hel"}' })).toEqual({
      type: 'delta',
      text: 'Hel',
    })
  })

  it('parses a terminal done frame', () => {
    expect(parseAskFrame({ event: 'done', data: '{"generation_id":"gen-9"}' })).toEqual({
      type: 'done',
      generation_id: 'gen-9',
    })
  })

  it('drops a ping keepalive / unknown event', () => {
    expect(parseAskFrame({ event: 'ping', data: '' })).toBeNull()
    expect(parseAskFrame({ event: 'nope', data: '{}' })).toBeNull()
    expect(parseAskFrame({ data: '{"text":"x"}' })).toBeNull()
  })

  it('drops malformed / mistyped frames', () => {
    expect(parseAskFrame({ event: 'delta', data: '{bad json' })).toBeNull()
    expect(parseAskFrame({ event: 'delta', data: '{"text":123}' })).toBeNull()
    expect(parseAskFrame({ event: 'done', data: '{}' })).toBeNull()
    expect(parseAskFrame({ event: 'done', data: '{"generation_id":""}' })).toBeNull()
  })
})

describe('askSession', () => {
  it('POSTs the question and streams delta frames then stops on done', async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse([
        'event: delta\ndata: {"text":"Hello"}\n\n',
        ': keepalive comment\n\n',
        'event: ping\ndata: {}\n\n',
        'event: delta\ndata: {"text":", world"}\n\n',
        'event: done\ndata: {"generation_id":"gen-42"}\n\n',
        // never reached — stream stops at the terminal `done` above
        'event: delta\ndata: {"text":"IGNORED"}\n\n',
      ]),
    ])
    const frames = await collect(
      askSession({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        question: 'What meds?',
        fetch,
      })
    )

    expect(frames).toEqual([
      { type: 'delta', text: 'Hello' },
      { type: 'delta', text: ', world' },
      { type: 'done', generation_id: 'gen-42' },
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/${SID}/ask`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.Authorization).toBe('Bearer t')
    expect(calls[0]!.headers.Accept).toBe('text/event-stream')
    expect(calls[0]!.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ question: 'What meds?' })
  })

  it('includes history in the POST body when provided', async () => {
    const { fetch, calls } = queuedFetch([
      sseResponse(['event: done\ndata: {"generation_id":"g"}\n\n']),
    ])
    await collect(
      askSession({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        question: 'Follow up?',
        history: [{ role: 'user', text: 'hi' }],
        fetch,
      })
    )
    expect(JSON.parse(String(calls[0]!.body))).toEqual({
      question: 'Follow up?',
      history: [{ role: 'user', text: 'hi' }],
    })
  })

  it('reassembles a frame split across chunk boundaries', async () => {
    const { fetch } = queuedFetch([
      sseResponse([
        'event: delta\ndata: {"text":"par',
        'tial"}\n\nevent: done\ndata: {"generation_id":"g"}\n\n',
      ]),
    ])
    const frames = await collect(
      askSession({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        question: 'q',
        fetch,
      })
    )
    expect(frames).toEqual([
      { type: 'delta', text: 'partial' },
      { type: 'done', generation_id: 'g' },
    ])
  })

  it('throws a typed error on a non-2xx status (not retried)', async () => {
    const { fetch, calls } = queuedFetch([sseResponse([], 404)])
    await expect(
      collect(
        askSession({
          baseUrl: BASE,
          workspaceId: WS,
          sessionId: SID,
          token: 't',
          question: 'q',
          fetch,
        })
      )
    ).rejects.toBeInstanceOf(NotFoundError)
    expect(calls).toHaveLength(1)
  })

  it('does NOT replay the POST when the stream drops after a partial answer', async () => {
    // First (and only) response yields a delta then closes WITHOUT a `done`.
    const { fetch, calls } = queuedFetch([
      sseResponse(['event: delta\ndata: {"text":"partial"}\n\n']),
    ])
    const gen = askSession({
      baseUrl: BASE,
      workspaceId: WS,
      sessionId: SID,
      token: 't',
      question: 'q',
      fetch,
      maxRetries: 3,
    })
    const seen: AskStreamFrame[] = []
    const err = await (async () => {
      try {
        for await (const f of gen) {
          seen.push(f)
        }
        return undefined
      } catch (e) {
        return e
      }
    })()
    expect(seen).toEqual([{ type: 'delta', text: 'partial' }])
    expect(err).toBeInstanceOf(NetworkError)
    // No re-POST after progress — exactly one call despite maxRetries=3.
    expect(calls).toHaveLength(1)
  })

  it('binds fetch to globalThis (no Illegal invocation for native-like fetch)', async () => {
    const nativeLike = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(sseResponse(['event: done\ndata: {"generation_id":"g"}\n\n']))
    } as unknown as FetchLike
    const frames = await collect(
      askSession({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        question: 'q',
        fetch: nativeLike,
      })
    )
    expect(frames).toEqual([{ type: 'done', generation_id: 'g' }])
  })

  it('stops when the caller aborts before the request', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = queuedFetch([
      sseResponse(['event: done\ndata: {"generation_id":"g"}\n\n']),
    ])
    const frames = await collect(
      askSession({
        baseUrl: BASE,
        workspaceId: WS,
        sessionId: SID,
        token: 't',
        question: 'q',
        fetch,
        signal: controller.signal,
      })
    )
    expect(frames).toEqual([])
    expect(calls).toHaveLength(0)
  })

  it('validates required inputs', async () => {
    await expect(
      collect(
        askSession({ baseUrl: BASE, workspaceId: WS, sessionId: '', token: 't', question: 'q' })
      )
    ).rejects.toThrow(/sessionId is required/)
    await expect(
      collect(
        askSession({ baseUrl: BASE, workspaceId: WS, sessionId: SID, token: 't', question: '' })
      )
    ).rejects.toThrow(/question is required/)
  })
})
