/**
 * Unit coverage for the GA 0.4.0 (phases 02–08) additions to `ScribeClient`:
 * attach-ticket, the Zoom saga/controls/OAuth/connection, versioned note write /
 * finalize (`base_version`), code decisions, checklist toggles, the async
 * `202`-enqueue envelope, and the per-call `timeoutMs`. Mocked transport only.
 */
import { describe, expect, it } from 'vitest'
import { ScribeClient } from '../src/client'
import { ConfigurationError, ConflictError, NotFoundError, TimeoutError } from '../src/errors'
import { isGenerationEnqueued } from '../src/types'
import { mockFetch } from './test-helpers'

const BASE = 'https://api.example.test'
const WS = 'ws-123'
const TOKEN = 'test-token'

function client(fetch: ReturnType<typeof mockFetch>['fetch']) {
  return new ScribeClient({ baseUrl: BASE, token: TOKEN, workspaceId: WS, fetch })
}

describe('mintTicket', () => {
  it('POSTs to the ticket path and returns the ticket', async () => {
    const ticket = { ticket: 'jwt.attach.ticket', expires_at: '2026-07-30T00:05:00Z' }
    const { fetch, calls } = mockFetch([{ status: 200, body: ticket }])
    const result = await client(fetch).mintTicket('sess-1')

    expect(result).toEqual(ticket)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/ticket`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).mintTicket('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('createZoomSession', () => {
  it('POSTs the meeting link + disclosure to /zoom/sessions and returns session + bot_id', async () => {
    const body = { session: { id: 'sess-z' }, bot_id: 'bot-9' }
    const { fetch, calls } = mockFetch([{ status: 201, body }])
    const result = await client(fetch).createZoomSession({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
    })

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/zoom/sessions`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
    })
  })

  it('serializes the note-gen fields (first/last name, visit type, note template) into the body', async () => {
    const body = { session: { id: 'sess-z' }, bot_id: 'bot-9' }
    const { fetch, calls } = mockFetch([{ status: 201, body }])
    await client(fetch).createZoomSession({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
      first_name: 'Ada',
      last_name: 'Lovelace',
      visit_type: 'psych-intake',
      note_template: 'amd-psych-intake',
    })

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
      first_name: 'Ada',
      last_name: 'Lovelace',
      visit_type: 'psych-intake',
      note_template: 'amd-psych-intake',
    })
  })

  it('accepts explicit nulls for the note-gen fields', async () => {
    const body = { session: { id: 'sess-z' }, bot_id: 'bot-9' }
    const { fetch, calls } = mockFetch([{ status: 201, body }])
    await client(fetch).createZoomSession({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
      first_name: null,
      last_name: null,
      visit_type: null,
      note_template: null,
    })

    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      meeting_link: 'https://zoom.us/j/123',
      disclosure: { enabled: true },
      first_name: null,
      last_name: null,
      visit_type: null,
      note_template: null,
    })
  })

  it('maps 409 (not connected / external_id collision) to ConflictError', async () => {
    const { fetch } = mockFetch([{ status: 409, body: { code: 'zoom_not_connected' } }])
    await expect(
      client(fetch).createZoomSession({ meeting_link: 'x', disclosure: { enabled: false } })
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('pauseZoom / resumeZoom', () => {
  it('POSTs to the pause path and returns the bot status', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { bot_status: 'paused' } }])
    const result = await client(fetch).pauseZoom('sess-1')
    expect(result).toEqual({ bot_status: 'paused' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/zoom/pause`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('POSTs to the resume path and returns the bot status', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: { bot_status: 'listening' } }])
    const result = await client(fetch).resumeZoom('sess-1')
    expect(result).toEqual({ bot_status: 'listening' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/zoom/resume`)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).pauseZoom('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('endZoom', () => {
  it('DELETEs the zoom path and returns the draining ack', async () => {
    const { fetch, calls } = mockFetch([{ status: 202, body: { status: 'draining' } }])
    const result = await client(fetch).endZoom('sess-1')
    expect(result).toEqual({ status: 'draining' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/zoom`)
    expect(calls[0]!.init?.method).toBe('DELETE')
  })
})

describe('getZoomConnection / disconnectZoom / authorizeZoomOAuth', () => {
  it('GETs the connection status', async () => {
    const conn = { connected: true, connected_at: '2026-07-01T00:00:00Z', zoom_email: 'a@b.co' }
    const { fetch, calls } = mockFetch([{ status: 200, body: conn }])
    const result = await client(fetch).getZoomConnection()
    expect(result).toEqual(conn)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/zoom/connection`)
    expect(calls[0]!.init?.method).toBe('GET')
  })

  it('DELETEs the connection (204, no body)', async () => {
    const { fetch, calls } = mockFetch([{ status: 204 }])
    await expect(client(fetch).disconnectZoom()).resolves.toBeUndefined()
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/zoom/connection`)
    expect(calls[0]!.init?.method).toBe('DELETE')
  })

  it('POSTs to authorize and returns the authorize_url', async () => {
    const body = { authorize_url: 'https://zoom.us/oauth/authorize?x=1', expires_at: 't' }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).authorizeZoomOAuth()
    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/zoom/oauth/authorize`)
    expect(calls[0]!.init?.method).toBe('POST')
  })
})

describe('putNote (versioned autosave)', () => {
  it('PUTs the base_version + body and returns the new version', async () => {
    const { fetch, calls } = mockFetch([
      { status: 200, body: { version: 4, updated_at: '2026-07-30T00:00:00Z' } },
    ])
    const result = await client(fetch).putNote('sess-1', { base_version: 3, body: 'edited' })

    expect(result.version).toBe(4)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/note`)
    expect(calls[0]!.init?.method).toBe('PUT')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ base_version: 3, body: 'edited' })
  })

  it('maps a stale base_version 409 to ConflictError (version_conflict)', async () => {
    const { fetch } = mockFetch([
      { status: 409, body: { code: 'version_conflict', message: 'stale base_version' } },
    ])
    const err = await client(fetch)
      .putNote('sess-1', { base_version: 1, body: 'x' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).errorCode).toBe('version_conflict')
  })

  it('maps a post-finalize 409 to ConflictError (invalid_session_state)', async () => {
    const { fetch } = mockFetch([
      { status: 409, body: { code: 'invalid_session_state', message: 'note is finalized' } },
    ])
    const err = await client(fetch)
      .putNote('sess-1', { base_version: 5, body: 'x' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).errorCode).toBe('invalid_session_state')
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).putNote('', { base_version: 1 })).rejects.toBeInstanceOf(
      ConfigurationError
    )
  })
})

describe('patchCode', () => {
  it('PATCHes the suggestion path with the decision', async () => {
    const body = { id: 'sug-1', code: 'E11.9', decision: 'approved', decided_at: 't' }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).patchCode('sess-1', 'sug-1', { decision: 'approved' })

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/codes/sug-1`)
    expect(calls[0]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ decision: 'approved' })
  })

  it('url-encodes the suggestion id', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }])
    await client(fetch).patchCode('sess-1', 'a/b', { decision: 'rejected' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/codes/a%2Fb`)
  })

  it('requires a suggestionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(
      client(fetch).patchCode('sess-1', '', { decision: 'approved' })
    ).rejects.toBeInstanceOf(ConfigurationError)
  })

  it('passes through the widened text-edit body (code/description/rationale)', async () => {
    const body = {
      id: 'sug-1',
      code: 'E11.65',
      decision: 'approved',
      decided_at: 't',
      source: 'provider',
    }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).patchCode('sess-1', 'sug-1', {
      code: 'E11.65',
      description: 'Type 2 diabetes mellitus with hyperglycemia',
      rationale: 'Corrected per chart review',
    })

    expect(result).toEqual(body)
    expect(calls[0]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      code: 'E11.65',
      description: 'Type 2 diabetes mellitus with hyperglycemia',
      rationale: 'Corrected per chart review',
    })
  })

  it('passes through a decision + text edit together', async () => {
    const { fetch, calls } = mockFetch([{ status: 200, body: {} }])
    await client(fetch).patchCode('sess-1', 'sug-1', {
      decision: 'approved',
      description: 'Refined description',
    })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      decision: 'approved',
      description: 'Refined description',
    })
  })
})

describe('createCode', () => {
  it('POSTs a provider-authored code to the manual path and returns the persisted suggestion', async () => {
    const body = {
      id: 'sug-9',
      code: 'I10',
      description: 'Essential (primary) hypertension',
      rationale: '',
      source: 'provider',
      decision: 'approved',
    }
    const { fetch, calls } = mockFetch([{ status: 201, body }])
    const result = await client(fetch).createCode('sess-1', {
      code: 'I10',
      description: 'Essential (primary) hypertension',
      rationale: '',
    })

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/codes/manual`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      code: 'I10',
      description: 'Essential (primary) hypertension',
      rationale: '',
    })
  })

  it('passes through a non-empty rationale', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: {} }])
    await client(fetch).createCode('sess-1', {
      code: 'E11.9',
      description: 'Type 2 diabetes mellitus without complications',
      rationale: 'Documented in assessment',
    })
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      code: 'E11.9',
      description: 'Type 2 diabetes mellitus without complications',
      rationale: 'Documented in assessment',
    })
  })

  it('url-encodes the session id', async () => {
    const { fetch, calls } = mockFetch([{ status: 201, body: {} }])
    await client(fetch).createCode('a/b', { code: 'I10', description: 'HTN', rationale: '' })
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/a%2Fb/codes/manual`)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(
      client(fetch).createCode('', { code: 'I10', description: 'HTN', rationale: '' })
    ).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('patchChecklist', () => {
  it('PATCHes the checklist path with the manual toggles', async () => {
    const body = { session_id: 'sess-1', title: 'T', status: 'open', items: [], updated_at: 't' }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).patchChecklist('sess-1', {
      items: [{ id: 'a', completed: true, source: 'manual' as const }],
    })

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/checklist`)
    expect(calls[0]!.init?.method).toBe('PATCH')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      items: [{ id: 'a', completed: true, source: 'manual' as const }],
    })
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no checklist' } }])
    await expect(
      client(fetch).patchChecklist('sess-1', {
        items: [{ id: 'a', completed: true, source: 'manual' as const }],
      })
    ).rejects.toBeInstanceOf(NotFoundError)
  })
})

describe('generate* async 202/200 envelope', () => {
  it('returns the synchronous artifact on 200 (not enqueued)', async () => {
    const body = {
      note: { session_id: 'sess-1', body: 'x' },
      generation: { id: 'g', model_provider: 'openai' },
    }
    const { fetch } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).generateNote('sess-1', { note_type: 'soap' })
    expect(isGenerationEnqueued(result)).toBe(false)
  })

  it('returns the enqueue envelope on 202 (isGenerationEnqueued === true)', async () => {
    const body = { generation: { id: 'gen-1', artifact_kind: 'note', status: 'pending' } }
    const { fetch } = mockFetch([{ status: 202, body }])
    const result = await client(fetch).generateNote('sess-1', { note_type: 'soap' })
    expect(isGenerationEnqueued(result)).toBe(true)
    if (isGenerationEnqueued(result)) {
      expect(result.generation.status).toBe('pending')
      expect(result.generation.artifact_kind).toBe('note')
    }
  })
})

describe('per-call timeoutMs', () => {
  it('aborts a hung request and throws TimeoutError', async () => {
    // A fetch that never resolves until its signal aborts.
    const hangingFetch = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        if (signal) {
          signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
            once: true,
          })
        }
      })) as unknown as ReturnType<typeof mockFetch>['fetch']

    const c = new ScribeClient({
      baseUrl: BASE,
      token: TOKEN,
      workspaceId: WS,
      fetch: hangingFetch,
    })
    const err = await c.getSession('sess-1', { timeoutMs: 20 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as TimeoutError).timeoutMs).toBe(20)
  })

  it('does not time out a fast request', async () => {
    const { fetch } = mockFetch([{ status: 200, body: { id: 'sess-1' } }])
    await expect(client(fetch).getSession('sess-1', { timeoutMs: 5_000 })).resolves.toEqual({
      id: 'sess-1',
    })
  })
})

describe('async token provider (smoke)', () => {
  it('instantiates with an async token supplier and resolves it per request', async () => {
    let calls = 0
    const c = new ScribeClient({
      baseUrl: BASE,
      workspaceId: WS,
      token: async () => {
        calls += 1
        return `dynamic-token-${calls}`
      },
      fetch: mockFetch([{ status: 200, body: { id: 'sess-1' } }]).fetch,
    })
    expect(c).toBeInstanceOf(ScribeClient)
    await expect(c.getSession('sess-1')).resolves.toBeTruthy()
    expect(calls).toBe(1)
  })
})
