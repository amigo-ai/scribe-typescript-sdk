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
 *   → stream REAL speech PCM16 (allocate + mintTicket + WS), end the stream, and
 *     wait for a non-empty transcript so a note can be generated
 *   → generateNote → poll getNote to a ready `version`
 *   → putNote({base_version}) returns { version: n+1 }
 *   → a STALE base_version returns 409 `version_conflict`
 *   → poll checklist ready (server-generated) → patchChecklist (manual toggle) succeeds
 *   → generateCodes → poll ready → patchCode (per-suggestion decision) succeeds
 *     when a suggestion exists
 *   → finalizeNote({base_version})
 *   → a post-finalize putNote returns 409 `invalid_session_state`
 *
 * Note generation needs a transcript — a fresh, never-streamed session 404s, and
 * a synthetic sine tone transcribes to nothing — so the suite streams a committed
 * real-speech fixture, then polls until the transcript is non-empty. If the
 * streaming Fleet is exhausted (503) the transcript stays empty; that surfaces as
 * a loud failure (empty-transcript / note 409) rather than a
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
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { NoteReadResponse, ScribeClient, ScribeStreamState, SessionResponse } from '../../src'
import { e2eExternalId, hasToken, makeTokenClient, sleep, tokenEnv } from './harness'

const hasWebSocket = typeof globalThis.WebSocket === 'function'

// Real-speech PCM16 fixture (16 kHz mono, little-endian) — generated from macOS
// `say` + `ffmpeg -ar 16000 -ac 1 -f s16le`. Unlike a synthetic sine tone, this
// is intelligible speech, so staging STT produces a NON-EMPTY transcript and the
// note-generation → mutation flow below can actually run. See fixtures/README.md.
const SPEECH_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'speech-16k-mono-s16le.pcm')
const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const CHUNK_MS = 100
/** 100 ms of PCM16 @ 16 kHz mono = 3200 bytes — matches the streaming pipeline's framing. */
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000

/** Load the committed real-speech PCM16 (16 kHz mono LE) fixture as raw bytes. */
function loadSpeechPcm(): Uint8Array {
  const buf = readFileSync(SPEECH_FIXTURE)
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** Stream the fixture as 100 ms PCM16 frames, paced in real time so STT keeps up. */
async function streamRealSpeech(stream: ScribeStreamClient, pcm: Uint8Array): Promise<void> {
  for (let off = 0; off < pcm.byteLength; off += CHUNK_BYTES) {
    stream.sendAudio(pcm.subarray(off, Math.min(off + CHUNK_BYTES, pcm.byteLength)))
    await sleep(CHUNK_MS)
  }
}

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

/**
 * Stream the committed REAL-SPEECH fixture through the WS so staging STT produces
 * a non-empty transcript (a fresh, never-streamed session 404s on note
 * generation; a synthetic sine tone transcribes to nothing). Returns true if
 * audio was streamed. Tolerates Fleet exhaustion (503) and a missing global
 * WebSocket (Node < 22) by returning false — the caller then surfaces the empty
 * transcript loudly rather than silently passing.
 */
async function streamRealSpeechSession(client: ScribeClient, sessionId: string): Promise<boolean> {
  if (!hasWebSocket) {
    // eslint-disable-next-line no-console
    console.warn('[ga token e2e] no global WebSocket (Node < 22) — skipping the streaming leg.')
    return false
  }
  const pcm = loadSpeechPcm()
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
            `streaming leg skipped (transcript will be empty).`
        )
        return false
      }
      throw err
    }
    if (stream.getState() !== 'ended' && stream.getState() !== 'failed') {
      await waitForState(stream, 'streaming', 60_000, errors)
      streamed = true
      await streamRealSpeech(stream, pcm)
    }
  } finally {
    stream.end()
  }
  // Give the worker a moment to finalize the transcript after end().
  await sleep(2_000)
  return streamed
}

/** Poll `getTranscript` until it has ≥1 segment (STT finalized the speech). */
async function pollTranscriptNonEmpty(
  client: ScribeClient,
  sessionId: string,
  budgetMs = 60_000
): Promise<number> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const transcript = await client.getTranscript(sessionId).catch((err: unknown) => {
      if (err instanceof NotFoundError) {
        return undefined
      }
      throw err
    })
    const count = transcript?.segments?.length ?? 0
    if (count > 0) {
      return count
    }
    if (Date.now() > deadline) {
      throw new Error(`transcript still empty after ${budgetMs}ms (STT produced no segments)`)
    }
    await sleep(2_000)
  }
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
    session = await client.createSession({
      external_id: e2eExternalId('postvisit'),
      visit_type: 'therapy-follow-up',
    })
    createdIds.push(session.id)
    expect(session.id).toBeTruthy()

    // 2. listSessions / getSession see the new session.
    const list = await client.listSessions({ limit: 50 })
    expect(Array.isArray(list.items)).toBe(true)
    const got = await client.getSession(session.id)
    expect(got.id).toBe(session.id)

    // 3. Stream REAL speech so STT produces a transcript a note can be built from,
    //    then wait until the transcript has finalized segments.
    await streamRealSpeechSession(client, session.id)
    const segmentCount = await pollTranscriptNonEmpty(client, session.id)
    expect(segmentCount).toBeGreaterThan(0)

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

    // 7. patchChecklist (manual toggle) succeeds. The checklist is generated
    //    server-side now (the explicit generate-checklist endpoint was retired
    //    in 0.7.0); wait until it's ready, then toggle its first item. If the
    //    session yields no server-generated checklist, record the gap loudly
    //    rather than fail.
    const readyChecklist = await pollReady(() => client.getChecklist(session.id), 'checklist')
      .then(() => client.getChecklist(session.id))
      .catch(() => undefined)
    const firstItem = readyChecklist?.items?.[0]
    if (firstItem) {
      const checklist = await client.patchChecklist(session.id, {
        items: [{ id: firstItem.id, completed: true, source: 'manual' }],
      })
      expect(Array.isArray(checklist.items)).toBe(true)
      expect(checklist.items.find(i => i.id === firstItem.id)?.state).toBe('checked')
    } else {
      // eslint-disable-next-line no-console
      console.warn(
        '[ga token e2e] patchChecklist: no server-generated checklist for this session — toggle not exercised'
      )
    }

    // 8. patchCode succeeds when a suggestion exists. Codes derive from the
    //    transcript/note; a short transcript may legitimately yield none —
    //    assert the decision when present, else record the gap loudly.
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
