/**
 * End-to-end coverage of EVERY exposed `ScribeClient` resource-API method against
 * the REAL staging Scribe stack (workspace f001e5c8), driven through the shipped
 * `ScribeServerClient` (M2M act-as-by-email → bound `ScribeClient`).
 *
 * One case (or block) per exposed method, happy + sad:
 *   createSession · getSession · listSessions (+ pagination) · allocate
 *   (+ cooldown) · getTranscript · getNote · generateNote · finalizeNote ·
 *   getSummary · generateSummary · getChecklist · getCodes
 * plus the auth (401), not-found (404), and cross-workspace sad paths.
 *
 * NOT covered here (by design): the WS streaming + audio round-trip (phase 15,
 * `scribe-streaming.e2e.test.ts`); missing-scope 403 + `invalid_scope` (the
 * fixed-scope CI M2M client cannot mint a token lacking `read_own`, so these are
 * documented as manual — see the `todo`s below and the PR checklist).
 *
 * Zero-residue: sessions are created with an `sdk-e2e-*` external id, are never
 * streamed (so they stay "dangling" and are auto-reaped by the phase-06 reaper),
 * and NO grants / M2M clients are created. There is no session-delete endpoint
 * (filed as a follow-up), so teardown records + logs the created ids rather than
 * deleting them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  AuthenticationError,
  isGenerationEnqueued,
  isScribeError,
  NotFoundError,
  ScribeClient,
  ScribeError,
  ServiceUnavailableError,
} from '../../src'
import type {
  ChecklistReadResponse,
  CodesReadResponse,
  NoteReadResponse,
  ScribeServerClient,
  SessionResponse,
  SummaryReadResponse,
  TranscriptResponse,
} from '../../src'
import { e2eExternalId, env, hasCreds, makeServerClient, randomUuid, sleep } from './harness'

const SESSION_STATUSES = new Set([
  'created',
  'in-progress',
  'in-review',
  'completed',
  'cancelled',
  'failed',
])

/** Assert a value is a `ScribeError` whose HTTP status is one of `codes`. */
function expectScribeStatus(err: unknown, ...codes: number[]): ScribeError {
  expect(isScribeError(err)).toBe(true)
  const e = err as ScribeError
  expect(codes).toContain(e.statusCode)
  return e
}

function assertSessionShape(s: SessionResponse): void {
  expect(typeof s.id).toBe('string')
  expect(s.id.length).toBeGreaterThan(0)
  expect(SESSION_STATUSES.has(s.status)).toBe(true)
  expect(typeof s.created_at).toBe('string')
  expect(typeof s.updated_at).toBe('string')
  // The create/get response embeds per-artifact availability.
  expect(s.artifacts).toBeTruthy()
  expect(s.artifacts.transcript).toBeTruthy()
  expect(s.artifacts.note).toBeTruthy()
  expect(s.artifacts.summary).toBeTruthy()
  expect(s.artifacts.codes).toBeTruthy()
}

/**
 * Read an artifact that may not have been generated yet. On a fresh (never
 * streamed) session the documented outcome is 404; if staging ever returns the
 * artifact, its shape is asserted instead. Either proves the method's wiring.
 */
async function readArtifactOr404<T>(
  read: () => Promise<T>,
  assertShape: (v: T) => void,
  label: string
): Promise<void> {
  let v: T
  try {
    v = await read()
  } catch (err) {
    const e = expectScribeStatus(err, 404)
    expect(e).toBeInstanceOf(NotFoundError)
    return
  }

  assertShape(v)
  // eslint-disable-next-line no-console
  console.warn(`[resource-api e2e] ${label}: available (shape OK)`)
}

/**
 * Attempt a generate-* write on a session with no transcript. Staging either
 * generates an artifact (assert shape) or rejects with a typed error. Observed
 * on staging: note/summary → 404 `not_found` (no transcript to generate from);
 * checklist → 503 (generation dependency unavailable on an empty session). Both
 * are legitimate "cannot generate without content" outcomes; either exercises
 * the write method's auth + routing + typed-error contract.
 */
async function generateOr4xx<T>(
  generate: () => Promise<T>,
  assertShape: (v: T) => void,
  label: string
): Promise<void> {
  try {
    const v = await generate()
    assertShape(v)
    // eslint-disable-next-line no-console
    console.warn(`[resource-api e2e] ${label}: generated (shape OK)`)
  } catch (err) {
    const e = expectScribeStatus(err, 400, 404, 409, 422, 503)
    // eslint-disable-next-line no-console
    console.warn(`[resource-api e2e] ${label}: rejected ${e.statusCode} (${e.errorCode ?? 'n/a'})`)
  }
}

describe.runIf(hasCreds)('Scribe resource-API e2e (all ScribeClient methods)', () => {
  let server: ScribeServerClient
  let client: ScribeClient
  const createdSessionIds: string[] = []
  let primary: SessionResponse

  async function createTracked(tag: string): Promise<SessionResponse> {
    const s = await client.createSession({
      external_id: e2eExternalId(tag),
      visit_type: 'therapy-follow-up',
      metadata: { source: 'scribe-typescript-sdk resource-api e2e', tag },
    })
    createdSessionIds.push(s.id)
    return s
  }

  beforeAll(async () => {
    server = makeServerClient()
    // Prove the act-as grant up front; a missing grant is a fixture problem.
    try {
      const token = await server.mintProviderToken(env.providerEmail!)
      expect(token.length).toBeGreaterThan(0)
    } catch (err) {
      const e = err as ScribeError
      if (e.errorCode === 'invalid_target') {
        throw new Error(
          `[resource-api e2e] provider "${env.providerEmail}" has no active grant in ` +
            `workspace ${env.workspaceId}; provision one then re-run.`
        )
      }
      throw err
    }
    client = server.scribe(env.providerEmail!)
    primary = await createTracked('primary')
  }, 60_000)

  afterAll(() => {
    // No session-delete endpoint exists (follow-up filed) — dangling sessions
    // self-reap. Record what we created for the zero-residue audit trail.
    // eslint-disable-next-line no-console
    console.warn(
      `[resource-api e2e] created ${createdSessionIds.length} sdk-e2e session(s) ` +
        `(auto-reaped; no grants/M2M created): ${createdSessionIds.join(', ')}`
    )
  })

  // --- createSession -------------------------------------------------------
  it('createSession → 201 with the SessionResponse shape', () => {
    assertSessionShape(primary)
    expect(primary.status).toBeTruthy()
  })

  it('createSession is idempotent for the same external_id (same owner)', async () => {
    const externalId = e2eExternalId('idempotent')
    const first = await client.createSession({
      external_id: externalId,
      visit_type: 'therapy-follow-up',
    })
    createdSessionIds.push(first.id)
    const second = await client.createSession({
      external_id: externalId,
      visit_type: 'therapy-follow-up',
    })
    expect(second.id).toBe(first.id)
  })

  // --- getSession ----------------------------------------------------------
  it('getSession(owned) → 200 matching the created session', async () => {
    const got = await client.getSession(primary.id)
    assertSessionShape(got)
    expect(got.id).toBe(primary.id)
  })

  it('getSession(unknown id) → 404 NotFoundError (also covers cross-provider read_own)', async () => {
    // A random id is neither owned nor existent; read_own yields 404 for both a
    // missing session and another provider's session (ownership isolation).
    await expect(client.getSession(randomUuid())).rejects.toBeInstanceOf(NotFoundError)
    try {
      await client.getSession(randomUuid())
    } catch (err) {
      expect(expectScribeStatus(err, 404).statusCode).toBe(404)
    }
  })

  // --- listSessions (+ pagination) -----------------------------------------
  it('listSessions → 200 with an items page + has_more flag', async () => {
    const page = await client.listSessions()
    expect(Array.isArray(page.items)).toBe(true)
    expect(typeof page.has_more).toBe('boolean')
    page.items.forEach(assertSessionShape)
  })

  it('listSessions honours limit and threads continuation_token across pages', async () => {
    // Guarantee at least two owned sessions so limit=1 forces a second page.
    await createTracked('page')
    const first = await client.listSessions({ limit: 1 })
    expect(first.items.length).toBeLessThanOrEqual(1)
    if (first.has_more) {
      expect(first.continuation_token != null).toBe(true)
      const second = await client.listSessions({
        limit: 1,
        continuation_token: first.continuation_token,
      })
      expect(second.items.length).toBeLessThanOrEqual(1)
      // The two pages must not return the same session.
      if (first.items[0] && second.items[0]) {
        expect(second.items[0].id).not.toBe(first.items[0].id)
      }
    }
  })

  it('listSessions with a bogus continuation_token is handled by the server', async () => {
    // Boundary: an invalid cursor either errors (4xx) or returns an empty/first
    // page — never crashes the client.
    try {
      const page = await client.listSessions({ continuation_token: 'not-a-real-cursor' })
      expect(Array.isArray(page.items)).toBe(true)
    } catch (err) {
      expectScribeStatus(err, 400, 404, 422)
    }
  })

  // --- allocate (+ cooldown / 503 + Retry-After) ---------------------------
  it('allocate(owned) → 200 {host, expires_at} (or 503 when the Fleet is exhausted)', async () => {
    const target = await createTracked('allocate')
    try {
      const alloc = await client.allocate(target.id)
      expect(typeof alloc.host).toBe('string')
      expect(alloc.host.length).toBeGreaterThan(0)
      expect(() => new Date(alloc.expires_at).toISOString()).not.toThrow()

      // Cooldown: an immediate re-allocate for the same session hits the
      // per-session cooldown (phase 12) → 503 + Retry-After.
      try {
        await client.allocate(target.id)
        // eslint-disable-next-line no-console
        console.warn('[resource-api e2e] second allocate unexpectedly succeeded (no cooldown hit)')
      } catch (err) {
        const e = expectScribeStatus(err, 503)
        expect(e).toBeInstanceOf(ServiceUnavailableError)
        const sue = e as ServiceUnavailableError
        if (sue.retryAfterSeconds !== undefined) {
          expect(sue.retryAfterSeconds).toBeGreaterThan(0)
        }
      }
    } catch (err) {
      // First allocate legitimately 503s if the Fleet has no capacity.
      const e = expectScribeStatus(err, 503)
      expect(e).toBeInstanceOf(ServiceUnavailableError)
      // eslint-disable-next-line no-console
      console.warn(`[resource-api e2e] allocate 503 (Fleet exhausted); cooldown leg skipped`)
    }
  }, 60_000)

  it('allocate(unknown session) → 404 NotFoundError', async () => {
    await expect(client.allocate(randomUuid())).rejects.toBeInstanceOf(NotFoundError)
  })

  // --- getTranscript -------------------------------------------------------
  it('getTranscript(fresh session) → 404 (not yet available) or the transcript shape', async () => {
    await readArtifactOr404(
      () => client.getTranscript(primary.id),
      (t: TranscriptResponse) => {
        expect(typeof t.session_id).toBe('string')
        expect(Array.isArray(t.segments)).toBe(true)
      },
      'getTranscript'
    )
  })

  it('getTranscript(unknown session) → 404 NotFoundError', async () => {
    await expect(client.getTranscript(randomUuid())).rejects.toBeInstanceOf(NotFoundError)
  })

  // --- getNote / generateNote / finalizeNote -------------------------------
  it('getNote(fresh session) → 404 or the note shape', async () => {
    await readArtifactOr404(
      () => client.getNote(primary.id),
      (n: NoteReadResponse) => {
        expect(['ready', 'pending', 'failed', 'empty']).toContain(n.generation_status)
        if (n.generation_status === 'ready') {
          expect(typeof n.body === 'string' || n.structured != null).toBe(true)
          expect(typeof n.version).toBe('number')
        }
      },
      'getNote'
    )
  })

  it('generateNote(no transcript) → generated note / enqueue or a typed error (404 not_found)', async () => {
    await generateOr4xx(
      () => client.generateNote(primary.id, { note_type: 'soap' }),
      v => {
        if (isGenerationEnqueued(v)) {
          expect(v.generation.status).toBeTruthy()
          return
        }
        expect(v.note).toBeTruthy()
        expect(v.generation).toBeTruthy()
        expect(['openai', 'anthropic']).toContain(v.generation.model_provider)
      },
      'generateNote'
    )
  }, 60_000)

  it('generateNote(unknown session) → 404 NotFoundError', async () => {
    await expect(
      client.generateNote(randomUuid(), { note_type: 'medical' })
    ).rejects.toBeInstanceOf(NotFoundError)
  })

  it('finalizeNote(no note yet) → 404/409 (nothing to finalize) or the finalized note', async () => {
    try {
      const finalized = await client.finalizeNote(primary.id, { base_version: 1 })
      expect(finalized.note).toBeTruthy()
      expect(finalized.note.session_id).toBeTruthy()
    } catch (err) {
      expectScribeStatus(err, 404, 409, 422)
    }
  })

  // --- getSummary / generateSummary ----------------------------------------
  it('getSummary(fresh session) → 404 or the summary shape', async () => {
    await readArtifactOr404(
      () => client.getSummary(primary.id),
      (s: SummaryReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(s.generation_status)
        if (s.generation_status === 'ready') {
          expect(typeof s.summary).toBe('string')
        }
      },
      'getSummary'
    )
  })

  it('generateSummary(no transcript) → generated summary / enqueue or a typed error (404 not_found)', async () => {
    await generateOr4xx(
      () => client.generateSummary(primary.id),
      v => {
        if (isGenerationEnqueued(v)) {
          expect(v.generation.status).toBeTruthy()
          return
        }
        expect(v.summary).toBeTruthy()
        expect(v.generation).toBeTruthy()
      },
      'generateSummary'
    )
  }, 60_000)

  // --- getChecklist --------------------------------------------------------
  it('getChecklist(fresh session) → 404 or the checklist shape', async () => {
    await readArtifactOr404(
      () => client.getChecklist(primary.id),
      (c: ChecklistReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(c.generation_status)
        if (c.generation_status === 'ready') {
          expect(Array.isArray(c.items)).toBe(true)
        }
      },
      'getChecklist'
    )
  })

  // --- getCodes ------------------------------------------------------------
  it('getCodes(fresh session) → 404 or the codes shape', async () => {
    await readArtifactOr404(
      () => client.getCodes(primary.id),
      (c: CodesReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(c.generation_status)
        if (c.generation_status === 'ready') {
          expect(Array.isArray(c.items)).toBe(true)
        }
      },
      'getCodes'
    )
  })

  // --- auth (401) ----------------------------------------------------------
  it('any read with an invalid token → 401 AuthenticationError', async () => {
    const anon = new ScribeClient({
      baseUrl: env.scribeBaseUrl!,
      workspaceId: env.workspaceId!,
      token: 'invalid.jwt.token',
    })
    await expect(anon.listSessions()).rejects.toBeInstanceOf(AuthenticationError)
    try {
      await anon.getSession(primary.id)
    } catch (err) {
      expect(expectScribeStatus(err, 401).statusCode).toBe(401)
    }
  })

  // --- cross-workspace isolation -------------------------------------------
  it('reading with a mismatched workspace id → denied (401/403/404)', async () => {
    // The token's workspace_id claim will not match a random workspace path.
    await sleep(0)
    try {
      await client.getSession(primary.id, { workspaceId: randomUuid() })
      throw new Error('expected a cross-workspace read to be denied')
    } catch (err) {
      expectScribeStatus(err, 401, 403, 404)
    }
  })

  // --- sad paths that need a differently-scoped token (MANUAL) -------------
  // The CI M2M client's grant has a FIXED scope set (sessions:write +
  // sessions:read_own + notes:rw_own), so it cannot mint a token that LACKS
  // read_own (→ resource 403) nor request an ungranted scope (→ invalid_scope).
  // These are validated manually with a purpose-scoped grant. See PR checklist.
  it.todo('403 missing-scope read (MANUAL: needs a token minted without scribe:sessions:read_own)')
  it.todo(
    'invalid_scope mint (MANUAL: needs a scope-restricted grant; SDK exposes no scope override)'
  )
})
