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

describe('listSessions', () => {
  it('GETs /v1/{ws}/sessions and returns the page', async () => {
    const page = {
      items: [{ id: 'sess-1' }, { id: 'sess-2' }],
      has_more: true,
      continuation_token: 'next-cursor',
    }
    const { fetch, calls } = mockFetch([{ status: 200, body: page }])
    const result = await client(fetch).listSessions()

    expect(result).toEqual(page)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('threads limit + continuation_token into the query string', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [], has_more: false } }])
    await client(fetch).listSessions({ limit: 25, continuation_token: 'abc def' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions?limit=25&continuation_token=abc+def`)
  })

  it('omits absent query params', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { items: [], has_more: false } }])
    await client(fetch).listSessions({ limit: 5 })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions?limit=5`)
  })

  it('maps 403 to PermissionError', async () => {
    const { fetch } = mockFetch([{ status: 403, body: { message: 'wrong workspace' } }])
    await expect(client(fetch).listSessions()).rejects.toBeInstanceOf(PermissionError)
  })
})

describe('getSession', () => {
  it('GETs /v1/{ws}/sessions/{id} and returns the session', async () => {
    const session = { id: 'sess-1', status: 'created' }
    const { fetch, calls } = mockFetch([{ status: 200, body: session }])
    const result = await client(fetch).getSession('sess-1')

    expect(result).toEqual(session)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('url-encodes the session id', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { id: 'x' } }])
    await client(fetch).getSession('a/b c')
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/a%2Fb%20c`)
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no session' } }])
    await expect(client(fetch).getSession('nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getSession('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('getNote', () => {
  it('GETs the note path and returns the note', async () => {
    const note = { session_id: 'sess-1', type: 'soap', status: 'draft', body: 'text' }
    const { fetch, calls } = mockFetch([{ status: 200, body: note }])
    const result = await client(fetch).getNote('sess-1')

    expect(result).toEqual(note)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/note`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 (not yet generated) to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no note' } }])
    await expect(client(fetch).getNote('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getNote('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('generateNote', () => {
  it('POSTs to the note path with the JSON body and returns the generated note', async () => {
    const generated = { note: { session_id: 'sess-1', body: 'x' }, generation: { id: 'gen-1' } }
    const { fetch, calls } = mockFetch([{ status: 200, body: generated }])
    const result = await client(fetch).generateNote('sess-1', {
      note_type: 'soap',
      instructions: 'be concise',
    })

    expect(result).toEqual(generated)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/note`)
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      note_type: 'soap',
      instructions: 'be concise',
    })
  })

  it('serializes a note_type-only body', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { note: {}, generation: {} } }])
    await client(fetch).generateNote('sess-1', { note_type: 'soap' })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ note_type: 'soap' })
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no session' } }])
    await expect(client(fetch).generateNote('nope', { note_type: 'soap' })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).generateNote('', { note_type: 'soap' })).rejects.toBeInstanceOf(
      ConfigurationError
    )
  })
})

describe('finalizeNote', () => {
  it('POSTs to the finalize path with no body and returns the finalized note', async () => {
    const finalized = { note: { session_id: 'sess-1', status: 'signed', body: 'x' } }
    const { fetch, calls } = mockFetch([{ status: 200, body: finalized }])
    const result = await client(fetch).finalizeNote('sess-1')

    expect(result).toEqual(finalized)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/note/finalize`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 (no note to finalize) to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no note' } }])
    await expect(client(fetch).finalizeNote('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).finalizeNote('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('getSummary', () => {
  it('GETs the summary path and returns the summary', async () => {
    const summary = { session_id: 'sess-1', summary: 'text' }
    const { fetch, calls } = mockFetch([{ status: 200, body: summary }])
    const result = await client(fetch).getSummary('sess-1')

    expect(result).toEqual(summary)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/summary`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no summary' } }])
    await expect(client(fetch).getSummary('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getSummary('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('generateSummary', () => {
  it('POSTs to the summary path with no body and returns the generated summary', async () => {
    const generated = { summary: { session_id: 'sess-1', summary: 'x' }, generation: { id: 'g' } }
    const { fetch, calls } = mockFetch([{ status: 200, body: generated }])
    const result = await client(fetch).generateSummary('sess-1')

    expect(result).toEqual(generated)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/summary`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no session' } }])
    await expect(client(fetch).generateSummary('nope')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).generateSummary('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('getChecklist', () => {
  it('GETs the checklist path and returns the checklist', async () => {
    const checklist = { session_id: 'sess-1', title: 'Intake', status: 'ready', items: [] }
    const { fetch, calls } = mockFetch([{ status: 200, body: checklist }])
    const result = await client(fetch).getChecklist('sess-1')

    expect(result).toEqual(checklist)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/checklist`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no checklist' } }])
    await expect(client(fetch).getChecklist('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getChecklist('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('generateChecklist', () => {
  it('POSTs to the checklist path with the JSON body and returns the generated checklist', async () => {
    const generated = { checklist: { session_id: 'sess-1', items: [] }, generation: { id: 'g' } }
    const { fetch, calls } = mockFetch([{ status: 200, body: generated }])
    const result = await client(fetch).generateChecklist('sess-1', {
      title: 'Intake',
      items: ['vitals', 'allergies'],
    })

    expect(result).toEqual(generated)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/checklist`)
    expect(calls[0]!.init?.method).toBe('POST')
    const headers = calls[0]!.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      title: 'Intake',
      items: ['vitals', 'allergies'],
    })
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no session' } }])
    await expect(client(fetch).generateChecklist('nope', { items: ['x'] })).rejects.toBeInstanceOf(
      NotFoundError
    )
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).generateChecklist('', { items: ['x'] })).rejects.toBeInstanceOf(
      ConfigurationError
    )
  })
})

describe('getCodes', () => {
  it('GETs the codes path and returns the codes', async () => {
    const codes = { session_id: 'sess-1', items: [{ code: 'E11.9', system: 'ICD-10' }] }
    const { fetch, calls } = mockFetch([{ status: 200, body: codes }])
    const result = await client(fetch).getCodes('sess-1')

    expect(result).toEqual(codes)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/codes`)
    expect(calls[0]!.init?.method).toBe('GET')
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no codes' } }])
    await expect(client(fetch).getCodes('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getCodes('')).rejects.toBeInstanceOf(ConfigurationError)
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
