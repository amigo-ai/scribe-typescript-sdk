/**
 * End-to-end CRUD tests against a REAL Scribe endpoint.
 *
 * GATED: skipped unless credentials are present. The provider token can come
 * from either source (so this runs in CI with the same secrets as the streaming
 * suite, no separate static JWT needed):
 *   A) a static provider JWT in SCRIBE_E2E_TOKEN (handy locally), OR
 *   B) minted via the provider-M2M `client_credentials` + `provider_email`
 *      grant (SCRIBE_M2M_CLIENT_ID/SECRET + SCRIBE_E2E_IDENTITY_BASE_URL +
 *      SCRIBE_E2E_PROVIDER_EMAIL).
 *
 * Required env:
 *   SCRIBE_E2E_BASE_URL      base URL of the Scribe/platform API
 *   SCRIBE_E2E_WORKSPACE_ID  workspace id (must match the token's claim)
 *   + either SCRIBE_E2E_TOKEN, or the four M2M vars above.
 * Optional:
 *   SCRIBE_E2E_ENABLED=false explicit opt-out
 */
import 'dotenv/config'
import { beforeAll, describe, expect, it } from 'vitest'
import { NotFoundError, ScribeClient, ServiceUnavailableError } from '../../src'
import { mintM2mProviderToken } from './scribe-auth'

const baseUrl = process.env.SCRIBE_E2E_BASE_URL
const workspaceId = process.env.SCRIBE_E2E_WORKSPACE_ID
const staticToken = process.env.SCRIBE_E2E_TOKEN
// M2M fallback (same creds the streaming suite uses).
const identityBaseUrl = process.env.SCRIBE_E2E_IDENTITY_BASE_URL
const providerEmail = process.env.SCRIBE_E2E_PROVIDER_EMAIL
const clientId = process.env.SCRIBE_M2M_CLIENT_ID
const clientSecret = process.env.SCRIBE_M2M_CLIENT_SECRET
const canMintM2m = Boolean(identityBaseUrl && providerEmail && clientId && clientSecret)
const explicitlyDisabled = process.env.SCRIBE_E2E_ENABLED === 'false'

const hasCreds =
  Boolean(baseUrl && workspaceId && (staticToken || canMintM2m)) && !explicitlyDisabled

if (!hasCreds) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scribe e2e] skipped — set SCRIBE_E2E_BASE_URL + SCRIBE_E2E_WORKSPACE_ID and either ' +
      'SCRIBE_E2E_TOKEN or the M2M vars (SCRIBE_M2M_CLIENT_ID/SECRET, ' +
      'SCRIBE_E2E_IDENTITY_BASE_URL, SCRIBE_E2E_PROVIDER_EMAIL) to run.'
  )
}

describe.runIf(hasCreds)('Scribe CRUD e2e (create → allocate → get-transcript)', () => {
  let client: ScribeClient

  beforeAll(async () => {
    const token =
      staticToken ??
      (await mintM2mProviderToken({
        identityBaseUrl: identityBaseUrl!,
        clientId: clientId!,
        clientSecret: clientSecret!,
        providerEmail: providerEmail!,
      }))
    client = new ScribeClient({ baseUrl: baseUrl!, token, workspaceId: workspaceId! })
  }, 30_000)

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
