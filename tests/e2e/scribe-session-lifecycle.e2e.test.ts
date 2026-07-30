/**
 * End-to-end coverage of the artifact resource APIs in the LOGICAL ORDER of a
 * real Scribe session — the happy path a customer app actually drives:
 *
 *   create session
 *     → start the stream (allocate + attach ticket + WS connect)
 *     → stream some audio
 *     → generate a checklist (mid-session)
 *     → stream more audio
 *     → generate a checklist again
 *     → end the stream
 *     → generate the note + summary (codes has no generate endpoint — it is a
 *       read-only artifact produced by the pipeline)
 *     → read every persisted artifact (transcript, note, summary, checklist,
 *       codes) as that clinician.
 *
 * This spins up a live session ONLY insofar as the artifact resource APIs need
 * real content to act on (per the phase scope). It does NOT re-assert the WS
 * streaming transport (attach/acks/pong/reconnect) — that is phase 15
 * (`scribe-streaming.e2e.test.ts`); here the stream is setup, and the assertions
 * are on the resource/artifact methods.
 *
 * Headless CI has no mic, so audio is SYNTHETIC PCM16 (a tone). A pure tone
 * yields little/no transcript, so generate-* / read-* are asserted tolerantly
 * (real artifact shape when produced, else the documented not-ready/typed
 * error) — the value here is exercising the methods in the correct SEQUENCE
 * against a real, streamed, ended session.
 *
 * Zero-residue: the session uses an `sdk-e2e-*` external id and is ended cleanly
 * (WS `end`); no grants / M2M clients are created.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isGenerationEnqueued, ScribeStreamClient, ServiceUnavailableError } from '../../src'
import type {
  ChecklistReadResponse,
  CodesReadResponse,
  NoteReadResponse,
  ScribeClient,
  ScribeServerClient,
  ScribeStreamState,
  SummaryReadResponse,
  TranscriptResponse,
} from '../../src'
import { e2eExternalId, env, hasCreds, makeServerClient, sleep, synthPcm16 } from './harness'

const hasWebSocket = typeof globalThis.WebSocket === 'function'

/** Poll `getState()` until it reaches `target` or fails/times out. */
async function waitForState(
  client: ScribeStreamClient,
  target: ScribeStreamState,
  timeoutMs: number,
  errors: Error[]
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const s = client.getState()
    if (s === target) {
      return
    }
    if (s === 'failed') {
      throw errors[errors.length - 1] ?? new Error('stream failed')
    }
    await sleep(100)
  }
  throw new Error(`timed out waiting for state="${target}" (last="${client.getState()}")`)
}

/** Stream `durationMs` of synthetic PCM16 in 100 ms chunks. */
async function streamAudio(client: ScribeStreamClient, durationMs: number): Promise<void> {
  const chunks = Math.floor(durationMs / 100)
  for (let i = 0; i < chunks; i++) {
    client.sendAudio(synthPcm16(100))
    await sleep(100)
  }
}

describe.runIf(hasCreds)('Scribe session lifecycle e2e (real happy-path artifact ordering)', () => {
  let server: ScribeServerClient
  let client: ScribeClient
  const createdSessionIds: string[] = []

  beforeAll(async () => {
    server = makeServerClient()
    try {
      await server.mintProviderToken(env.providerEmail!)
    } catch (err) {
      const e = err as { errorCode?: string }
      if (e.errorCode === 'invalid_target') {
        throw new Error(
          `[lifecycle e2e] provider "${env.providerEmail}" has no active grant in ` +
            `workspace ${env.workspaceId}; provision one then re-run.`
        )
      }
      throw err
    }
    client = server.scribe(env.providerEmail!)
  }, 60_000)

  afterAll(() => {
    // eslint-disable-next-line no-console
    console.warn(
      `[lifecycle e2e] created ${createdSessionIds.length} sdk-e2e session(s) ` +
        `(streamed + ended; no grants/M2M created): ${createdSessionIds.join(', ')}`
    )
  })

  it('create → stream → generate checklist (x2) → end → generate note/summary → read artifacts', async () => {
    if (!hasWebSocket) {
      // eslint-disable-next-line no-console
      console.warn('[lifecycle e2e] no global WebSocket (Node < 22) — skipping.')
      return
    }

    // 1. create session
    const session = await client.createSession({
      external_id: e2eExternalId('lifecycle'),
      metadata: { source: 'scribe-typescript-sdk lifecycle e2e' },
    })
    createdSessionIds.push(session.id)
    expect(session.id).toBeTruthy()

    // 2. start the stream (allocate + token_exchange ticket + WS connect)
    const errors: Error[] = []
    const stream = new ScribeStreamClient({
      sessionId: session.id,
      connectionProvider: async sid => {
        const conn = await server.prepareConnection(env.providerEmail!, sid)
        return { host: conn.host, ticket: conn.ticket }
      },
      onError: e => errors.push(e),
      keepaliveIntervalMs: 2_000,
    })

    let streamed = false
    try {
      try {
        await stream.connect()
      } catch (err) {
        // Fleet exhaustion legitimately 503s — skip the streamed legs but still
        // exercise the post-session generate/read ordering below on the (empty)
        // session so the resource methods are covered.
        if (err instanceof ServiceUnavailableError) {
          // eslint-disable-next-line no-console
          console.warn(
            `[lifecycle e2e] allocate 503 (retry ${err.retryAfterSeconds}s) — Fleet exhausted; ` +
              `streaming legs skipped, running generate/read ordering on an empty session.`
          )
        } else {
          throw err
        }
      }

      if (stream.getState() !== 'ended' && stream.getState() !== 'failed') {
        await waitForState(stream, 'streaming', 60_000, errors)
        streamed = true

        // 3. stream some audio
        await streamAudio(stream, 2_000)

        // 4. generate a checklist mid-session
        await generateChecklistTolerant(client, session.id)

        // 5. stream more audio
        await streamAudio(stream, 2_000)

        // 6. generate a checklist again
        await generateChecklistTolerant(client, session.id)
      }
    } finally {
      // 7. end the stream
      stream.end()
    }
    if (streamed) {
      expect(stream.getState()).toBe('ended')
    }

    // Give the worker a moment to finalize the transcript after end().
    await sleep(2_000)

    // 8. generate the note + summary (codes is read-only — no generate endpoint)
    await generateNoteTolerant(client, session.id)
    await generateSummaryTolerant(client, session.id)

    // 9. read every persisted artifact as the clinician, in order.
    await readArtifactTolerant(
      () => client.getTranscript(session.id),
      (t: TranscriptResponse) => {
        expect(typeof t.session_id).toBe('string')
        expect(Array.isArray(t.segments)).toBe(true)
      },
      'getTranscript'
    )
    await readArtifactTolerant(
      () => client.getNote(session.id),
      (n: NoteReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(n.generation_status)
        if (n.generation_status === 'ready') {
          expect(typeof n.body === 'string' || n.structured != null).toBe(true)
          expect(typeof n.version).toBe('number')
        }
      },
      'getNote'
    )
    await readArtifactTolerant(
      () => client.getSummary(session.id),
      (s: SummaryReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(s.generation_status)
        if (s.generation_status === 'ready') {
          expect(typeof s.summary).toBe('string')
        }
      },
      'getSummary'
    )
    await readArtifactTolerant(
      () => client.getChecklist(session.id),
      (c: ChecklistReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(c.generation_status)
        if (c.generation_status === 'ready') {
          expect(Array.isArray(c.items)).toBe(true)
        }
      },
      'getChecklist'
    )
    await readArtifactTolerant(
      () => client.getCodes(session.id),
      (c: CodesReadResponse) => {
        expect(['ready', 'pending', 'failed']).toContain(c.generation_status)
        if (c.generation_status === 'ready') {
          expect(Array.isArray(c.items)).toBe(true)
        }
      },
      'getCodes'
    )
  }, 180_000)
})

async function generateChecklistTolerant(client: ScribeClient, sessionId: string): Promise<void> {
  try {
    const v = await client.generateChecklist(sessionId, {
      title: 'sdk-e2e visit checklist',
      items: [
        { id: 'a', label: 'Chief complaint documented' },
        { id: 'b', label: 'Vitals recorded' },
      ],
    })
    if (!isGenerationEnqueued(v)) {
      expect(v.checklist).toBeTruthy()
      expect(Array.isArray(v.checklist.items)).toBe(true)
    }
    // eslint-disable-next-line no-console
    console.warn('[lifecycle e2e] generateChecklist: generated')
  } catch (err) {
    logGenerateOutcome('generateChecklist', err)
  }
}

async function generateNoteTolerant(client: ScribeClient, sessionId: string): Promise<void> {
  try {
    const v = await client.generateNote(sessionId, { note_type: 'soap' })
    if (!isGenerationEnqueued(v)) {
      expect(v.note).toBeTruthy()
      expect(v.generation).toBeTruthy()
    }
    // eslint-disable-next-line no-console
    console.warn('[lifecycle e2e] generateNote: generated')
  } catch (err) {
    logGenerateOutcome('generateNote', err)
  }
}

async function generateSummaryTolerant(client: ScribeClient, sessionId: string): Promise<void> {
  try {
    const v = await client.generateSummary(sessionId)
    if (!isGenerationEnqueued(v)) {
      expect(v.summary).toBeTruthy()
      expect(v.generation).toBeTruthy()
    }
    // eslint-disable-next-line no-console
    console.warn('[lifecycle e2e] generateSummary: generated')
  } catch (err) {
    logGenerateOutcome('generateSummary', err)
  }
}

/** A generate-* on a tone-only session may 4xx/503 (no real content) — tolerate + log. */
function logGenerateOutcome(label: string, err: unknown): void {
  const e = err as { statusCode?: number; errorCode?: string }
  expect(typeof e.statusCode).toBe('number')
  expect(e.statusCode).toBeGreaterThanOrEqual(400)
  // eslint-disable-next-line no-console
  console.warn(`[lifecycle e2e] ${label}: not generated (${e.statusCode} ${e.errorCode ?? 'n/a'})`)
}

/** Read an artifact; assert its shape when present, tolerate the documented 404. */
async function readArtifactTolerant<T>(
  read: () => Promise<T>,
  assertShape: (v: T) => void,
  label: string
): Promise<void> {
  try {
    const v = await read()
    assertShape(v)
    // eslint-disable-next-line no-console
    console.warn(`[lifecycle e2e] ${label}: available (shape OK)`)
  } catch (err) {
    const e = err as { statusCode?: number }
    expect(e.statusCode).toBe(404)
  }
}
