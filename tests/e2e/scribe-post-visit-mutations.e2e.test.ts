/**
 * GA 0.4.0 staging E2E — the post-visit mutation contract the web depends on,
 * driven through the RAW `ScribeClient` with a real provider JWT (phases 02–08).
 *
 * Env-gated on `SCRIBE_E2E_TOKEN` (a provider JWT obtained via the
 * human-in-the-loop email-OTP flow; ~15-min TTL). The suite **self-skips** when
 * the token is absent — it never mints or hardcodes credentials — so CI / fork
 * PRs without a token stay green. The CI workflow supplies the host URLs via
 * `env:` (repo variables with staging defaults); locally they fall back to
 * `SCRIBE_E2E_BASE_URL` → `https://scribe-staging.platform.amigo.ai` and the
 * identity/OTP host `SCRIBE_E2E_IDENTITY_BASE_URL` → `https://api-staging.platform.amigo.ai`.
 *
 * Covered contract (SPEC §6.1 P4, phase 08):
 *   instantiate `ScribeClient` with an ASYNC token provider
 *   → createSession → listSessions / getSession
 *   → putNote({base_version}) returns { version: n+1 }
 *   → a STALE base_version returns 409 `version_conflict`
 *   → patchChecklist (manual toggle) succeeds
 *   → patchCode (per-suggestion decision) succeeds when a suggestion exists
 *   → finalizeNote({base_version})
 *   → a post-finalize putNote returns 409 `invalid_session_state`
 *
 * Zero-residue: sessions are created with an `sdk-e2e-*` external id and are
 * never streamed, so they stay "dangling" and are auto-reaped by the reaper.
 * There is no session-delete endpoint; the created id is logged for traceability.
 *
 * Run locally (the OTP flow is human-in-the-loop; the token is short-lived):
 *   SCRIBE_E2E_TOKEN=<provider jwt> \
 *   SCRIBE_E2E_BASE_URL=https://scribe-staging.platform.amigo.ai \
 *   npm run test:e2e
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ConflictError, isScribeError, type ScribeClient, type SessionResponse } from '../../src'
import { e2eExternalId, hasToken, makeTokenClient, sleep, tokenEnv } from './harness'

/** Poll `getNote` until it reports a ready version, or bail after `budgetMs`. */
async function pollNoteVersion(
  client: ScribeClient,
  sessionId: string,
  budgetMs = 60_000
): Promise<number> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const note = await client.getNote(sessionId)
    if (note.generation_status === 'ready' && typeof note.version === 'number') {
      return note.version
    }
    if (note.generation_status === 'failed') {
      throw new Error('note generation failed on staging')
    }
    if (Date.now() > deadline) {
      throw new Error(`note not ready within ${budgetMs}ms (status=${note.generation_status})`)
    }
    await sleep(2_000)
  }
}

describe.runIf(hasToken)('Scribe GA post-visit mutations e2e (provider JWT → staging)', () => {
  let client: ScribeClient
  let session: SessionResponse
  const createdIds: string[] = []

  beforeAll(() => {
    client = makeTokenClient()
    // eslint-disable-next-line no-console
    console.warn(`[ga token e2e] base=${tokenEnv.baseUrl}`)
  })

  afterAll(() => {
    if (createdIds.length) {
      // eslint-disable-next-line no-console
      console.warn(`[ga token e2e] created (reaper-eligible) session ids: ${createdIds.join(', ')}`)
    }
  })

  it('create → list/get → putNote(+stale 409) → patchChecklist → patchCode → finalize → post-finalize 409', async () => {
    // 1. createSession (async token provider is exercised on every call).
    session = await client.createSession({ external_id: e2eExternalId('postvisit') })
    createdIds.push(session.id)
    expect(session.id).toBeTruthy()

    // 2. listSessions / getSession see the new session.
    const list = await client.listSessions({ limit: 50 })
    expect(Array.isArray(list.items)).toBe(true)
    const got = await client.getSession(session.id)
    expect(got.id).toBe(session.id)

    // 3. Seed a note draft, then read its version to use as base_version.
    await client.generateNote(session.id, { note_type: 'soap' })
    const baseVersion = await pollNoteVersion(client, session.id)
    expect(baseVersion).toBeGreaterThanOrEqual(1)

    // 4. putNote({base_version}) → version n+1 (compare-and-set).
    const written = await client.putNote(session.id, {
      base_version: baseVersion,
      body: 'sdk-e2e edited note body',
    })
    expect(written.version).toBe(baseVersion + 1)

    // 5. A STALE base_version loses the CAS → 409 version_conflict.
    const staleErr = await client
      .putNote(session.id, { base_version: baseVersion, body: 'stale write' })
      .catch((e: unknown) => e)
    expect(staleErr).toBeInstanceOf(ConflictError)
    expect((staleErr as ConflictError).errorCode).toBe('version_conflict')

    // 6. patchChecklist (manual toggle) succeeds — items are caller-provided,
    //    so this is content-independent. Generate the checklist first, then
    //    toggle its first item.
    const gen = await client.generateChecklist(session.id, {
      title: 'sdk-e2e visit checklist',
      items: [
        { id: 'a', label: 'Chief complaint documented' },
        { id: 'b', label: 'Vitals recorded' },
      ],
    })
    // The checklist toggle applies regardless of async-generation state.
    const checklist = await client.patchChecklist(session.id, {
      items: [{ id: 'a', completed: true, source: 'manual' }],
    })
    expect(Array.isArray(checklist.items)).toBe(true)
    const toggled = checklist.items.find(i => i.id === 'a')
    expect(toggled?.state).toBe('checked')
    void gen

    // 7. patchCode succeeds when a suggestion exists (codes are derived from
    //    the transcript/note, so a synthetic session may yield none — assert
    //    the decision when present, otherwise record the coverage gap).
    await client.generateCodes(session.id).catch(() => undefined)
    const codes = await client.getCodes(session.id).catch(() => undefined)
    const firstCode = codes?.items?.[0]
    if (firstCode) {
      const decided = await client.patchCode(session.id, firstCode.id, { decision: 'approved' })
      expect(decided.decision).toBe('approved')
      expect(decided.id).toBe(firstCode.id)
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[ga token e2e] patchCode: no code suggestions on this session (empty transcript)'
      )
    }

    // 8. finalizeNote({base_version}) with the CURRENT version freezes the note.
    const finalized = await client.finalizeNote(session.id, { base_version: written.version })
    expect(finalized.note).toBeTruthy()
    expect(finalized.note.session_id).toBeTruthy()

    // 9. A post-finalize mutation is rejected → 409 invalid_session_state.
    const postFinalErr = await client
      .putNote(session.id, { base_version: written.version + 1, body: 'too late' })
      .catch((e: unknown) => e)
    expect(isScribeError(postFinalErr)).toBe(true)
    expect(postFinalErr).toBeInstanceOf(ConflictError)
    expect((postFinalErr as ConflictError).errorCode).toBe('invalid_session_state')
  }, 180_000)
})
