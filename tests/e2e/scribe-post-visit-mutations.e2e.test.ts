/**
 * GA 0.4.0 staging E2E — the post-visit mutation contract the web depends on,
 * driven through the RAW `ScribeClient` with a real provider JWT (phases 02–08).
 *
 * Env-gated on `SCRIBE_E2E_TOKEN` (a provider JWT obtained via the
 * human-in-the-loop email-OTP flow; ~15-min TTL). The suite **self-skips** when
 * the token is absent — it never mints or hardcodes credentials — so CI / fork
 * PRs without a token stay green. The host URLs are hard prerequisites (no
 * defaults): CI supplies `SCRIBE_E2E_BASE_URL` and `SCRIBE_E2E_IDENTITY_BASE_URL`
 * from repository variables behind a fail-fast preflight (staging:
 * `https://scribe-staging.platform.amigo.ai` and the identity/OTP host
 * `https://api-staging.platform.amigo.ai`); local runs must export them.
 *
 * Flow (SPEC §6.1 P4, phase 08):
 *   instantiate `ScribeClient` with an ASYNC token provider
 *   → createSession → listSessions / getSession
 *   → stream synthetic PCM16 (allocate + mintTicket + WS) so a note can be
 *     generated, then end the stream
 *   → generateNote → poll getNote to a ready `version`
 *   → putNote({base_version}) returns { version: n+1 }
 *   → a STALE base_version returns 409 `version_conflict`
 *   → generateChecklist → poll ready → patchChecklist (manual toggle) succeeds
 *   → generateCodes → poll ready → patchCode (per-suggestion decision) succeeds
 *     when a suggestion exists
 *   → finalizeNote({base_version})
 *   → a post-finalize putNote returns 409 `invalid_session_state`
 *
 * Note generation needs a transcript — a fresh, never-streamed session 404s — so
 * the suite streams a short synthetic session first (mirrors the lifecycle
 * suite, which runs green against staging). If the streaming Fleet is exhausted
 * (503) the note may not generate; that surfaces as a loud failure rather than a
 * silent pass.
 *
 * Zero-residue: sessions carry an `sdk-e2e-*` external id and are auto-reaped;
 * there is no session-delete endpoint, so the created id is logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConflictError,
  isGenerationEnqueued,
  isScribeError,
  NotFoundError,
  ScribeStreamClient,
  ServiceUnavailableError,
} from '../../src'
import type { NoteReadResponse, ScribeClient, ScribeStreamState, SessionResponse } from '../../src'
import { e2eExternalId, hasToken, makeTokenClient, sleep, synthPcm16, tokenEnv } from './harness'

const hasWebSocket = typeof globalThis.WebSocket === 'function'

/** Poll `getState()` until it reaches `target` or fails/times out. */
async function waitForState(
  stream: ScribeStreamClient,
  target: ScribeStreamState,
  timeoutMs: number,
  errors: Error[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = stream.getState()
    if (s === target) {
      return
    }
    if (s === 'failed') {
      throw errors[errors.length - 1] ?? new Error('stream failed')
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for state="${target}" (last="${stream.getState()}")`)
}

/** Stream `durationMs` of synthetic PCM16 in 100 ms chunks. */
async function streamAudio(stream: ScribeStreamClient, durationMs: number): Promise<void> {
  const chunks = Math.floor(durationMs / 100)
  for (let i = 0; i < chunks; i++) {
    stream.sendAudio(synthPcm16(100))
    await sleep(100)
  }
}

/**
 * Best-effort: stream a short synthetic session so a note can be generated.
 * Returns true if audio was streamed. Tolerates Fleet exhaustion (503) and a
 * missing global WebSocket (Node < 22) by returning false.
 */
async function streamSyntheticSession(client: ScribeClient, sessionId: string): Promise<boolean> {
  if (!hasWebSocket) {
    // eslint-disable-next-line no-console
    console.warn('[ga token e2e] no global WebSocket (Node < 22) — skipping the streaming leg.')
    return false
  }
  const errors: Error[] = []
  const stream = new ScribeStreamClient({
    sessionId,
    // Uses ONLY the provider JWT: allocate a host + mint an attach ticket.
    connectionProvider: async sid => {
      const alloc = await client.allocate(sid)
      const ticket = await client.mintTicket(sid)
      return { host: alloc.host, ticket: ticket.ticket }
    },
    onError: e => errors.push(e),
    keepaliveIntervalMs: 2_000,
  })
  let streamed = false
  try {
    try {
      await stream.connect()
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ga token e2e] allocate 503 (retry ${err.retryAfterSeconds}s) — Fleet exhausted; ` +
            `streaming leg skipped (note generation may 404).`
        )
        return false
      }
      throw err
    }
    if (stream.getState() !== 'ended' && stream.getState() !== 'failed') {
      await waitForState(stream, 'streaming', 60_000, errors)
      streamed = true
      await streamAudio(stream, 3_000)
    }
  } finally {
    stream.end()
  }
  // Give the worker a moment to finalize the transcript after end().
  await sleep(2_000)
  return streamed
}

/** Poll `getNote` until it reports a ready version (tolerating a transient 404). */
async function pollNoteReady(
  client: ScribeClient,
  sessionId: string,
  budgetMs = 90_000
): Promise<NoteReadResponse> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    let note: NoteReadResponse | undefined
    try {
      note = await client.getNote(sessionId)
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err
      }
    }
    if (note && note.generation_status === 'ready' && typeof note.version === 'number') {
      return note
    }
    if (note && note.generation_status === 'failed') {
      throw new Error('note generation failed on staging')
    }
    if (Date.now() > deadline) {
      throw new Error(
        `note not ready within ${budgetMs}ms (status=${note?.generation_status ?? 'not-found'})`
      )
    }
    await sleep(2_000)
  }
}

/** Poll a generated artifact's read shape until `generation_status === 'ready'`. */
async function pollReady(
  read: () => Promise<{ generation_status: 'ready' | 'pending' | 'failed' }>,
  label: string,
  budgetMs = 60_000
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const artifact = await read().catch((err: unknown) => {
      if (err instanceof NotFoundError) {
        return undefined
      }
      throw err
    })
    if (artifact?.generation_status === 'ready') {
      return
    }
    if (artifact?.generation_status === 'failed') {
      throw new Error(`${label} generation failed on staging`)
    }
    if (Date.now() > deadline) {
      throw new Error(`${label} not ready within ${budgetMs}ms`)
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

  it('create → list/get → stream → putNote(+stale 409) → patchChecklist → patchCode → finalize → post-finalize 409', async () => {
    // 1. createSession (async token provider is exercised on every call).
    session = await client.createSession({ external_id: e2eExternalId('postvisit') })
    createdIds.push(session.id)
    expect(session.id).toBeTruthy()

    // 2. listSessions / getSession see the new session.
    const list = await client.listSessions({ limit: 50 })
    expect(Array.isArray(list.items)).toBe(true)
    const got = await client.getSession(session.id)
    expect(got.id).toBe(session.id)

    // 3. Stream a short synthetic session so a note can be generated.
    await streamSyntheticSession(client, session.id)

    // 4. Generate the note, then read its ready version for the base_version.
    await client.generateNote(session.id, { note_type: 'soap' })
    const note = await pollNoteReady(client, session.id)
    const baseVersion = note.version as number
    expect(baseVersion).toBeGreaterThanOrEqual(1)

    // 5. putNote({base_version}) → version n+1 (compare-and-set). Send whichever
    //    of body/structured the stored note uses (exactly one is required).
    const patch =
      note.body == null && note.structured != null
        ? { base_version: baseVersion, structured: { ...note.structured, sdk_e2e_edit: true } }
        : { base_version: baseVersion, body: `${note.body ?? ''}\n\nsdk-e2e edit` }
    const written = await client.putNote(session.id, patch)
    expect(written.version).toBe(baseVersion + 1)

    // 6. A STALE base_version loses the CAS → 409 version_conflict.
    const staleErr = await client
      .putNote(session.id, { base_version: baseVersion, body: 'stale write' })
      .catch((e: unknown) => e)
    expect(staleErr).toBeInstanceOf(ConflictError)
    expect((staleErr as ConflictError).errorCode).toBe('version_conflict')

    // 7. patchChecklist (manual toggle) succeeds. Generate the checklist, wait
    //    until it's ready (generation may return a 202 enqueue), then toggle.
    const gen = await client.generateChecklist(session.id, {
      title: 'sdk-e2e visit checklist',
      items: [
        { id: 'a', label: 'Chief complaint documented' },
        { id: 'b', label: 'Vitals recorded' },
      ],
    })
    if (isGenerationEnqueued(gen)) {
      await pollReady(() => client.getChecklist(session.id), 'checklist')
    }
    const checklist = await client.patchChecklist(session.id, {
      items: [{ id: 'a', completed: true, source: 'manual' }],
    })
    expect(Array.isArray(checklist.items)).toBe(true)
    expect(checklist.items.find(i => i.id === 'a')?.state).toBe('checked')

    // 8. patchCode succeeds when a suggestion exists. Codes derive from the
    //    transcript/note; an empty synthetic transcript may legitimately yield
    //    none — assert the decision when present, else record the gap loudly.
    const codesGen = await client.generateCodes(session.id)
    if (isGenerationEnqueued(codesGen)) {
      await pollReady(() => client.getCodes(session.id), 'codes')
    }
    const codes = await client.getCodes(session.id)
    const firstCode = codes.items?.[0]
    if (firstCode) {
      const decided = await client.patchCode(session.id, firstCode.id, { decision: 'approved' })
      expect(decided.decision).toBe('approved')
      expect(decided.id).toBe(firstCode.id)
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[ga token e2e] patchCode: no code suggestions for this session (empty transcript) — decision not exercised'
      )
    }

    // 9. finalizeNote({base_version}) with the CURRENT version freezes the note.
    const finalized = await client.finalizeNote(session.id, { base_version: written.version })
    expect(finalized.note).toBeTruthy()
    expect(finalized.note.session_id).toBeTruthy()

    // 10. A post-finalize mutation is rejected → 409 invalid_session_state.
    const postFinalErr = await client
      .putNote(session.id, { base_version: written.version + 1, body: 'too late' })
      .catch((e: unknown) => e)
    expect(isScribeError(postFinalErr)).toBe(true)
    expect(postFinalErr).toBeInstanceOf(ConflictError)
    expect((postFinalErr as ConflictError).errorCode).toBe('invalid_session_state')
  }, 300_000)
})
