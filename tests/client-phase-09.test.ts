/**
 * Unit coverage for the phase-09 assist additions to `ScribeClient` (0.5.0):
 * the `actions` artifact (async 202/200 envelope + poller), section-scoped note
 * regeneration (stale/post-finalize 409s), checklist auto-check, and the `/ask`
 * streaming helper wired through the client. Mocked transport only.
 */
import { describe, expect, it } from 'vitest'
import { ScribeClient } from '../src/client'
import { ConfigurationError, ConflictError, NotFoundError } from '../src/errors'
import { isGenerationEnqueued } from '../src/types'
import type { AskStreamFrame } from '../src/ask-stream'
import { mockFetch } from './test-helpers'
import type { FetchLike } from '../src/http'

const BASE = 'https://api.example.test'
const WS = 'ws-123'
const TOKEN = 'test-token'

function client(fetch: FetchLike) {
  return new ScribeClient({ baseUrl: BASE, token: TOKEN, workspaceId: WS, fetch })
}

describe('getActions', () => {
  it('GETs the actions read shape', async () => {
    const body = {
      generation_status: 'ready',
      session_id: 'sess-1',
      items: [{ id: 'a1', text: 'Order labs', kind: 'order' }],
    }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).getActions('sess-1')

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/actions`)
    expect(calls[0]!.init?.method).toBe('GET')
  })

  it('maps 404 to NotFoundError', async () => {
    const { fetch } = mockFetch([{ status: 404, body: { message: 'no actions' } }])
    await expect(client(fetch).getActions('sess-1')).rejects.toBeInstanceOf(NotFoundError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).getActions('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('generateActions (async 202/200 envelope)', () => {
  it('POSTs and returns the synchronous artifact on 200 (not enqueued)', async () => {
    const body = {
      actions: { session_id: 'sess-1', items: [{ id: 'a1', text: 'x', kind: 'k' }] },
      generation: { id: 'g', model_provider: 'openai' },
    }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).generateActions('sess-1')

    expect(isGenerationEnqueued(result)).toBe(false)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/actions`)
    expect(calls[0]!.init?.method).toBe('POST')
  })

  it('returns the enqueue envelope on 202 with artifact_kind=actions', async () => {
    const body = { generation: { id: 'gen-7', artifact_kind: 'actions', status: 'pending' } }
    const { fetch } = mockFetch([{ status: 202, body }])
    const result = await client(fetch).generateActions('sess-1')

    expect(isGenerationEnqueued(result)).toBe(true)
    if (isGenerationEnqueued(result)) {
      expect(result.generation.status).toBe('pending')
      expect(result.generation.artifact_kind).toBe('actions')
    }
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).generateActions('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('actions poll cycle (202 → getActions ready)', () => {
  it('enqueues then polls the read shape to ready with items', async () => {
    const enqueue = { generation: { id: 'gen-7', artifact_kind: 'actions', status: 'pending' } }
    const pending = { generation_status: 'pending', session_id: 'sess-1', items: null }
    const ready = {
      generation_status: 'ready',
      session_id: 'sess-1',
      items: [{ id: 'a1', text: 'Follow up in 2 weeks', kind: 'followup' }],
    }
    const { fetch } = mockFetch([
      { status: 202, body: enqueue },
      { status: 200, body: pending },
      { status: 200, body: ready },
    ])
    const c = client(fetch)

    const gen = await c.generateActions('sess-1')
    expect(isGenerationEnqueued(gen)).toBe(true)

    let read = await c.getActions('sess-1')
    expect(read.generation_status).toBe('pending')
    read = await c.getActions('sess-1')
    expect(read.generation_status).toBe('ready')
    expect(read.items?.[0]?.id).toBe('a1')
  })
})

describe('regenerateSection', () => {
  it('POSTs {section_id, instructions?, base_version} and returns the 202 enqueue', async () => {
    const body = { generation: { id: 'gen-1', artifact_kind: 'note', status: 'pending' } }
    const { fetch, calls } = mockFetch([{ status: 202, body }])
    const result = await client(fetch).regenerateSection('sess-1', {
      section_id: 'hpi',
      instructions: 'tighten it up',
      base_version: 3,
    })

    expect(result.generation.id).toBe('gen-1')
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/note/regenerate-section`)
    expect(calls[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      section_id: 'hpi',
      instructions: 'tighten it up',
      base_version: 3,
    })
  })

  it('maps a stale base_version 409 to ConflictError (version_conflict)', async () => {
    const { fetch } = mockFetch([
      { status: 409, body: { code: 'version_conflict', message: 'stale base_version' } },
    ])
    const err = await client(fetch)
      .regenerateSection('sess-1', { section_id: 'hpi', base_version: 1 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).errorCode).toBe('version_conflict')
  })

  it('maps a post-finalize 409 to ConflictError (invalid_session_state)', async () => {
    const { fetch } = mockFetch([
      { status: 409, body: { code: 'invalid_session_state', message: 'note is finalized' } },
    ])
    const err = await client(fetch)
      .regenerateSection('sess-1', { section_id: 'hpi', base_version: 5 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).errorCode).toBe('invalid_session_state')
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(
      client(fetch).regenerateSection('', { section_id: 'hpi', base_version: 1 })
    ).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('autoCheckChecklist', () => {
  it('POSTs (no body) and returns the per-item matches', async () => {
    const body = {
      matches: [
        { item_id: 'a', matched: true, evidence: 'patient reported chest pain' },
        { item_id: 'b', matched: false },
      ],
    }
    const { fetch, calls } = mockFetch([{ status: 200, body }])
    const result = await client(fetch).autoCheckChecklist('sess-1')

    expect(result).toEqual(body)
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/checklist/auto-check`)
    expect(calls[0]!.init?.method).toBe('POST')
    // No request body (the endpoint takes `{}`).
    expect(calls[0]!.init?.body).toBeUndefined()
  })

  it('maps 409 (terminal session) to ConflictError', async () => {
    const { fetch } = mockFetch([{ status: 409, body: { code: 'invalid_session_state' } }])
    await expect(client(fetch).autoCheckChecklist('sess-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{}])
    await expect(client(fetch).autoCheckChecklist('')).rejects.toBeInstanceOf(ConfigurationError)
  })
})

describe('askSession (streaming Q&A via the client)', () => {
  /** A fetch that streams `chunks` as an SSE body once. */
  function sseFetch(chunks: string[]): { fetch: FetchLike; calls: Array<{ url: string; body: unknown }> } {
    const calls: Array<{ url: string; body: unknown }> = []
    const fetch: FetchLike = (url, init) => {
      calls.push({ url, body: init?.body })
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder()
          for (const c of chunks) {
            controller.enqueue(enc.encode(c))
          }
          controller.close()
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
    return { fetch, calls }
  }

  it('streams delta frames then done through the client method', async () => {
    const { fetch, calls } = sseFetch([
      'event: delta\ndata: {"text":"A"}\n\n',
      'event: delta\ndata: {"text":"B"}\n\n',
      'event: done\ndata: {"generation_id":"g-1"}\n\n',
    ])
    const frames: AskStreamFrame[] = []
    for await (const f of client(fetch).askSession('sess-1', { question: 'Any allergies?' })) {
      frames.push(f)
    }
    expect(frames).toEqual([
      { type: 'delta', text: 'A' },
      { type: 'delta', text: 'B' },
      { type: 'done', generation_id: 'g-1' },
    ])
    expect(calls[0]!.url).toBe(`${BASE}/v1/${WS}/sessions/sess-1/ask`)
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ question: 'Any allergies?' })
  })

  it('requires a sessionId and a question', async () => {
    const { fetch } = mockFetch([{}])
    expect(() => client(fetch).askSession('', { question: 'q' })).toThrow(ConfigurationError)
    expect(() => client(fetch).askSession('sess-1', { question: '' })).toThrow(ConfigurationError)
  })
})
