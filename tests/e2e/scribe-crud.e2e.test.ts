/**
 * End-to-end CRUD tests against a REAL Scribe endpoint.
 *
 * GATED: these are skipped unless the required env vars are present, so they
 * never run in CI (and are safe to run locally). See tests/e2e/README.md.
 *
 * Required env (e.g. in a local .env file, loaded via dotenv):
 *   SCRIBE_E2E_BASE_URL      base URL of the Scribe/platform API
 *   SCRIBE_E2E_TOKEN         provider JWT with scribe:sessions:write + read_own
 *   SCRIBE_E2E_WORKSPACE_ID  workspace id (must match the token's claim)
 * Optional:
 *   SCRIBE_E2E_ENABLED=true  belt-and-suspenders explicit opt-in
 */
import 'dotenv/config'
import { beforeAll, describe, expect, it } from 'vitest'
import { NotFoundError, ScribeClient, ServiceUnavailableError } from '../../src'

const baseUrl = process.env.SCRIBE_E2E_BASE_URL
const token = process.env.SCRIBE_E2E_TOKEN
const workspaceId = process.env.SCRIBE_E2E_WORKSPACE_ID
const explicitlyDisabled = process.env.SCRIBE_E2E_ENABLED === 'false'

const hasCreds = Boolean(baseUrl && token && workspaceId) && !explicitlyDisabled

if (!hasCreds) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scribe e2e] skipped — set SCRIBE_E2E_BASE_URL, SCRIBE_E2E_TOKEN, SCRIBE_E2E_WORKSPACE_ID to run.'
  )
}

describe.runIf(hasCreds)('Scribe CRUD e2e (create → allocate → get-transcript)', () => {
  let client: ScribeClient

  beforeAll(() => {
    client = new ScribeClient({ baseUrl: baseUrl!, token: token!, workspaceId: workspaceId! })
  })

  it('creates a session, allocates it, then reads its (pending) transcript', async () => {
    // 1. create-session
    const session = await client.createSession({
      external_id: `sdk-e2e-${Date.now()}`,
      metadata: { source: 'scribe-typescript-sdk e2e' },
    })
    expect(session.id).toBeTruthy()
    expect(session.status).toBeTruthy()

    // 2. allocate — may legitimately 503 if the Fleet is exhausted/unconfigured.
    try {
      const alloc = await client.allocate(session.id)
      expect(typeof alloc.host).toBe('string')
      expect(alloc.host.length).toBeGreaterThan(0)
      expect(() => new Date(alloc.expires_at).toISOString()).not.toThrow()
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        // eslint-disable-next-line no-console
        console.warn(`[scribe e2e] allocate returned 503 (retry after ${err.retryAfterSeconds}s)`)
      } else {
        throw err
      }
    }

    // 3. get-transcript — a fresh session has no transcript yet, so a 404
    // (NotFoundError) is the expected outcome; a real transcript is also fine.
    try {
      const transcript = await client.getTranscript(session.id)
      expect(transcript.session_id).toBeTruthy()
      expect(Array.isArray(transcript.segments)).toBe(true)
    } catch (err) {
      expect(err).toBeInstanceOf(NotFoundError)
    }
  })
})
