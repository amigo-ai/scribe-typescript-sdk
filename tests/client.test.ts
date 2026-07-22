import { describe, expect, it } from 'vitest'
import { ScribeClient } from '../src/client'
import {
  AuthenticationError,
  ConfigurationError,
  ConflictError,
  NetworkError,
  NotFoundError,
  PermissionError,
  ServiceUnavailableError,
} from '../src/errors'
import { mockFetch, rejectingFetch } from './test-helpers'

const BASE = 'https://api.example.test'
const WS = 'ws-123'
const TOKEN = 'test-token'

function client(fetch: ReturnType<typeof mockFetch>['fetch']) {
  return new ScribeClient({ baseUrl: BASE, token: TOKEN, workspaceId: WS, fetch })
}

describe('ScribeClient construction', () => {
  it('requires workspaceId', () => {
    expect(
      () =>
        new ScribeClient({
          baseUrl: BASE,
          token: TOKEN,
          workspaceId: '',
          fetch: mockFetch([{}]).fetch,
        })
    ).toThrow(ConfigurationError)
  })

  it('requires baseUrl and token', () => {
    const { fetch } = mockFetch([{}])
    // @ts-expect-error missing baseUrl
    expect(() => new ScribeClient({ token: TOKEN, workspaceId: WS, fetch })).toThrow(
      ConfigurationError
    )
    // @ts-expect-error missing token
    expect(() => new ScribeClient({ baseUrl: BASE, workspaceId: WS, fetch })).toThrow(
      ConfigurationError
    )
  })
})

describe('createSession', () => {
  it('POSTs to /v1/{ws}/sessions with bearer auth and JSON body', async () => {
    const session = {
      id: 'sess-1',
      status: 'created',
      created_at: '2026-07-19T00:00:00Z',
      updated_at: '2026-07-19T00:00:00Z',
      artifacts: { transcript: 'pending', note: 'pending', summary: 'pending', codes: 'pending' },
    }
    const { fetch, calls } = mockFetch([{ status: 201, body: session }])
    const result = await client(fetch).createSession({ external_id: 'appt-9', metadata: { a: 1 } })

    expect(result).toEqual(session)
    expect(result.id).toBe('sess-1') // ground-truth field is `id`, not `session_id`
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`${BASE}/v1/${WS}/sessions`)
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(call.init?.body))).toEqual({
      external_id: 'appt-9',
      metadata: { a: 1 },
    })
  })

  it('defaults to an empty body when no input is given', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: { id: 'x' } }])
    await client(fetch).createSession()
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({})
  })

  it('maps 409 to ConflictError', async () => {
    const { fetch } = mockFetch([{ status: 409, body: { message: 'external_id taken' } }])
    await expect(client(fetch).createSession({ external_id: 'dup' })).rejects.toBeInstanceOf(
      ConflictError
    )
  })

  it('maps 401 to AuthenticationError', async () => {
    const { fetch } = mockFetch([{ status: 401, body: { message: 'bad token' } }])
    await expect(client(fetch).createSession()).rejects.toBeInstanceOf(AuthenticationError)
  })
})

describe('allocate', () => {
  it('POSTs to the allocate path and returns { host, expires_at }', async () => {
    const alloc = {
      host: 'gs-abc.actors-staging.platform.amigo.ai',
      expires_at: '2026-07-19T02:00:00Z',
    }
    const { fetch, calls } = mockFetch([{ status: 200, body: alloc }])
    const result = await client(fetch).allocate('sess-1')

    expect(result).toEqual(alloc)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/allocate`)
    expect(calls[0]!.init?.method).toBe('POST')
    // allocate takes no request body
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('url-encodes the session id', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { host: 'h', expires_at: 't' } }])
    await client(fetch).allocate('a/b c')
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/a%2Fb%20c/allocate`)
  })

  it('maps 503 to ServiceUnavailableError with retryAfterSeconds from Retry-After', async () => {
    const { fetch } = mockFetch([
      { status: 503, body: { message: 'at capacity' }, headers: { 'Retry-After': '5' } },
    ])
    const err = await client(fetch)
      .allocate('sess-1')
      .catch(e => e)
    expect(err).toBeInstanceOf(ServiceUnavailableError)
    expect((err as ServiceUnavailableError).retryAfterSeconds).toBe(5)
    expect((err as ServiceUnavailableError).statusCode).toBe(503)
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no session' } }])
    await expect(client(fetch).allocate('nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).allocate('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('getTranscript', () => {
  it('GETs the transcript path and returns { session_id, segments }', async () => {
    const transcript = {
      session_id: 'sess-1',
      segments: [{ speaker: 'clinician', text: 'hello', start_ms: 0, end_ms: 500 }],
    }
    const { fetch, calls } = mockFetch([{ status: 200, body: transcript }])
    const result = await client(fetch).getTranscript('sess-1')

    expect(result).toEqual(transcript)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/transcript`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 403 to PermissionError', async () => {
    const { fetch } = mockFetch([{ status: 403, body: { message: 'wrong workspace' } }])
    await expect(client(fetch).getTranscript('sess-1')).rejects.toBeInstanceOf(PermissionError)
  })

  it('maps 404 (not yet available) to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'not available' } }])
    await expect(client(fetch).getTranscript('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('workspace + token handling', () => {
  it('allows per-call workspace override', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: { id: 'x' } }])
    await client(fetch).createSession({}, { workspaceId: 'other-ws' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/other-ws/sessions`)
  })

  it('resolves an async token provider per request', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: { id: 'x' } }])
    const c = new ScribeClient({
      baseUrl: BASE,
      workspaceId: WS,
      token: async () => 'fresh-jwt',
      fetch,
    })
    await c.createSession()
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer fresh-jwt')
  })

  it('strips a trailing slash from baseUrl', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: { id: 'x' } }])
    const c = new ScribeClient({ baseUrl: `${BASE}/`, token: TOKEN, workspaceId: WS, fetch })
    await c.createSession()
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions`)
  })
})

describe('transport errors', () => {
  it('wraps fetch rejections in NetworkError', async () => {
    const c = new ScribeClient({
      baseUrl: BASE,
      token: TOKEN,
      workspaceId: WS,
      fetch: rejectingFetch(new Error('ECONNREFUSED')),
    })
    const err = await c.createSession().catch(e => e)
    expect(err).toBeInstanceOf(NetworkError)
    expect((err as NetworkError).request?.method).toBe('POST')
  })
})
