/**
 * 0.5.0 staging E2E — the phase-09 ASSIST surface, driven through the RAW
 * `ScribeClient` with a real provider JWT: the `actions` artifact job cycle,
 * section-scoped note regeneration (valid + stale `base_version`), checklist
 * `auto-check`, and the `/ask` streaming Q&A helper.
 *
 * Env-gated on `SCRIBE_E2E_TOKEN` (a provider JWT from the human-in-the-loop
 * email-OTP flow; ~15-min TTL). The suite **self-skips** when the token is
 * absent — it never mints or hardcodes credentials — so CI / fork PRs without a
 * token stay green. Host URLs are hard prerequisites (staging:
 * `https://scribe-staging.platform.amigo.ai`, identity/OTP host
 * `https://api-staging.platform.amigo.ai`), supplied by CI repo variables; local
 * runs must export them.
 *
 * Flow (mirrors the GA post-visit suite's real-speech setup, then exercises the
 * assist endpoints against a session that HAS a transcript + note):
 *   createSession → stream the committed REAL-SPEECH fixture → transcript
 *   → generateNote → poll ready (need a note `version` for section-regen)
 *   → generateActions → poll getActions to a ready `{items}` artifact
 *   → regenerateSection({base_version}) → 202; a STALE base_version → 409
 *     version_conflict
 *   → poll checklist ready (server-generated) → autoCheckChecklist → 200 {matches}
 *   → askSession streams ≥1 `delta` frame then resolves on `done {generation_id}`
 *
 * Note generation (and thus a meaningful actions/regen/ask surface) needs a
 * transcript — a synthetic sine tone transcribes to nothing — so this streams
 * the committed real-speech PCM16 fixture and polls until the transcript is
 * non-empty. If the streaming Fleet is exhausted (503) the transcript stays
 * empty; that surfaces as a loud failure (empty-transcript / note not-ready)
 * rather than a silent pass.
 *
 * Zero-residue: sessions carry an `sdk-e2e-*` external id and are auto-reaped;
 * there is no session-delete endpoint, so created ids are logged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ConflictError,
  isGenerationEnqueued,
  NotFoundError,
  ScribeStreamClient,
  ServiceUnavailableError,
} from '../../src'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type {
  ActionsReadResponse,
  AskStreamFrame,
  NoteReadResponse,
  ScribeClient,
  ScribeStreamState,
  SessionResponse,
} from '../../src'
import { e2eExternalId, hasToken, makeTokenClient, sleep, tokenEnv } from './harness'

const hasWebSocket = typeof globalThis.WebSocket === 'function'

// Real-speech PCM16 fixture (16 kHz mono LE) — see fixtures/README.md. Unlike a
// synthetic sine tone, staging STT produces a NON-EMPTY transcript, so the note
// / actions / regen / ask flow below can actually run.
const SPEECH_FIXTURE = path.join(import.meta.dirname, 'fixtures', 'speech-16k-mono-s16le.pcm')
const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
const CHUNK_MS = 100
/** 100 ms of PCM16 @ 16 kHz mono = 3200 bytes — matches the streaming pipeline's framing. */
const CHUNK_BYTES = (SAMPLE_RATE * BYTES_PER_SAMPLE * CHUNK_MS) / 1000

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
 * Stream the committed real-speech fixture through the WS so staging STT produces
 * a non-empty transcript. Returns true if audio was streamed. Tolerates Fleet
 * exhaustion (503) and a missing global WebSocket (Node < 22) by returning false
 * — the caller then surfaces the empty transcript loudly rather than passing.
 */
async function streamRealSpeechSession(client: ScribeClient, sessionId: string): Promise<boolean> {
  if (!hasWebSocket) {
    // eslint-disable-next-line no-console
    console.warn('[assist token e2e] no global WebSocket (Node < 22) — skipping the streaming leg.')
    return false
  }
  const pcm = loadSpeechPcm()
  const errors: Error[] = []
  const stream = new ScribeStreamClient({
    sessionId,
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
          `[assist token e2e] allocate 503 (retry ${err.retryAfterSeconds}s) — Fleet exhausted; ` +
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

/** Poll `getActions` until it reports a ready artifact (tolerating a transient 404). */
async function pollActionsReady(
  client: ScribeClient,
  sessionId: string,
  budgetMs = 60_000
): Promise<ActionsReadResponse> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    let actions: ActionsReadResponse | undefined
    try {
      actions = await client.getActions(sessionId)
    } catch (err) {
      if (!(err instanceof NotFoundError)) {
        throw err
      }
    }
    if (actions && actions.generation_status === 'ready') {
      return actions
    }
    if (actions && actions.generation_status === 'failed') {
      throw new Error('actions generation failed on staging')
    }
    if (Date.now() > deadline) {
      throw new Error(
        `actions not ready within ${budgetMs}ms (status=${actions?.generation_status ?? 'not-found'})`
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

describe.runIf(hasToken)('Scribe assist surface e2e (provider JWT → staging)', () => {
  let client: ScribeClient
  let session: SessionResponse
  const createdIds: string[] = []

  beforeAll(() => {
    client = makeTokenClient()
    // eslint-disable-next-line no-console
    console.warn(`[assist token e2e] base=${tokenEnv.baseUrl}`)
  })

  afterAll(() => {
    if (createdIds.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[assist token e2e] created (reaper-eligible) session ids: ${createdIds.join(', ')}`
      )
    }
  })

  it('generateActions job→ready → regenerateSection(+stale 409) → autoCheckChecklist → /ask delta→done', async () => {
    // 1. Create a session and stream REAL speech so STT yields a transcript a
    //    note (and thus the assist surface) can be built from.
    session = await client.createSession({ external_id: e2eExternalId('assist') })
    createdIds.push(session.id)
    expect(session.id).toBeTruthy()

    await streamRealSpeechSession(client, session.id)
    const segmentCount = await pollTranscriptNonEmpty(client, session.id)
    expect(segmentCount).toBeGreaterThan(0)

    // 2. Generate the note → read its ready version (needed as base_version).
    await client.generateNote(session.id, { note_type: 'soap' })
    const note = await pollNoteReady(client, session.id)
    const baseVersion = note.version as number
    expect(baseVersion).toBeGreaterThanOrEqual(1)

    // 3. ACTIONS: generate → job pending (202) → poll getActions to a ready
    //    `{items}` artifact. (A 200 synchronous artifact is also acceptable.)
    const actionsGen = await client.generateActions(session.id)
    if (isGenerationEnqueued(actionsGen)) {
      expect(actionsGen.generation.artifact_kind).toBe('actions')
    }
    const actions = await pollActionsReady(client, session.id)
    expect(actions.generation_status).toBe('ready')
    expect(Array.isArray(actions.items)).toBe(true)

    // 4. REGENERATE-SECTION: a valid base_version → 202 enqueue. Pick a section
    //    id from the structured note when present, else a common SOAP section.
    const sectionId = firstSectionId(note) ?? 'subjective'
    const regen = await client.regenerateSection(session.id, {
      section_id: sectionId,
      base_version: baseVersion,
      instructions: 'Tighten the wording.',
    })
    expect(regen.generation).toBeTruthy()
    expect(regen.generation.id).toBeTruthy()

    // 4b. A STALE base_version (the section-regen just bumped the note version)
    //     loses the compare-and-set → 409 version_conflict. Wait for the regen to
    //     land so `baseVersion` is definitively stale.
    await pollNoteVersionAtLeast(client, session.id, baseVersion + 1)
    const staleErr = await client
      .regenerateSection(session.id, { section_id: sectionId, base_version: baseVersion })
      .catch((e: unknown) => e)
    expect(staleErr).toBeInstanceOf(ConflictError)
    expect((staleErr as ConflictError).errorCode).toBe('version_conflict')

    // 5. AUTO-CHECK: the checklist is generated server-side now (the explicit
    //    generate-checklist endpoint was retired in 0.7.0); wait until it is
    //    ready, then auto-check → 200 with a `matches` array (each
    //    `{item_id, matched, evidence?}`).
    await pollReady(() => client.getChecklist(session.id), 'checklist')
    const auto = await client.autoCheckChecklist(session.id)
    expect(Array.isArray(auto.matches)).toBe(true)
    for (const m of auto.matches) {
      expect(typeof m.item_id).toBe('string')
      expect(typeof m.matched).toBe('boolean')
    }

    // 6. /ASK: the SSE helper streams ≥1 `delta` frame then resolves on the
    //    terminal `done {generation_id}`.
    const frames: AskStreamFrame[] = []
    for await (const frame of client.askSession(session.id, {
      question: 'Summarize the visit in one sentence.',
    })) {
      frames.push(frame)
    }
    const deltas = frames.filter(f => f.type === 'delta')
    const done = frames.find(f => f.type === 'done')
    expect(deltas.length).toBeGreaterThanOrEqual(1)
    expect(done).toBeTruthy()
    expect((done as { generation_id?: string } | undefined)?.generation_id).toBeTruthy()
    // `done` is terminal — nothing is yielded after it.
    expect(frames[frames.length - 1]!.type).toBe('done')
  }, 300_000)
})

/** First section id from a structured note (best-effort), or undefined. */
function firstSectionId(note: NoteReadResponse): string | undefined {
  const structured = (note as { structured?: unknown }).structured
  if (structured && typeof structured === 'object') {
    const sections = (structured as { sections?: unknown }).sections
    if (Array.isArray(sections)) {
      for (const s of sections) {
        const id =
          (s as { id?: unknown; section_id?: unknown }).id ??
          (s as { section_id?: unknown }).section_id
        if (typeof id === 'string' && id) {
          return id
        }
      }
    }
  }
  return undefined
}

/** Poll `getNote` until the ready version is ≥ `target` (the regen landed). */
async function pollNoteVersionAtLeast(
  client: ScribeClient,
  sessionId: string,
  target: number,
  budgetMs = 90_000
): Promise<void> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    const note = await client.getNote(sessionId).catch((err: unknown) => {
      if (err instanceof NotFoundError) {
        return undefined
      }
      throw err
    })
    if (
      note &&
      note.generation_status === 'ready' &&
      typeof note.version === 'number' &&
      note.version >= target
    ) {
      return
    }
    if (note && note.generation_status === 'failed') {
      throw new Error('section regeneration failed on staging')
    }
    if (Date.now() > deadline) {
      throw new Error(`note version did not reach ${target} within ${budgetMs}ms`)
    }
    await sleep(2_000)
  }
}
