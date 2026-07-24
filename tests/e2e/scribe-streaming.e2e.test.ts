/**
 * End-to-end STREAMING test against the REAL staging Scribe stack — the full
 * superscribe-web in-person recording path, driven through the SDK:
 *
 *   1. Mint a per-clinician provider token via the provider-M2M
 *      `client_credentials` + `provider_email` (act-as-by-email) grant.
 *   2. `createSession` → `allocate` (CRUD REST client) as that clinician.
 *   3. Mint a `token_exchange` attach ticket (aud=scribe-streaming,
 *      scribe:streams:connect) bound to the session — wired as `ticketProvider`;
 *      `allocateProvider` re-runs allocate.
 *   4. `ScribeStreamClient.connect()` → `sendAudio(synthetic PCM16)` → observe
 *      acks / pong / transcripts → `end()`.
 *
 * Headless CI has no mic, so the "in-person stream with audio" is exercised with
 * SYNTHETIC PCM16 (a generated tone) fed to `sendAudio` — exactly what the
 * recording-independent client enables.
 *
 * GATED: skipped unless all required env vars are present (so forks / external
 * PRs without secrets self-skip and default CI stays green). Required env:
 *   SCRIBE_E2E_BASE_URL          scribe CRUD base URL (create/allocate)
 *   SCRIBE_E2E_IDENTITY_BASE_URL identity `/token` base URL (mints)
 *   SCRIBE_E2E_WORKSPACE_ID      workspace id (the M2M client's workspace)
 *   SCRIBE_E2E_PROVIDER_EMAIL    a provider WITH an active grant in that workspace
 *   SCRIBE_M2M_CLIENT_ID         provider-M2M client id
 *   SCRIBE_M2M_CLIENT_SECRET     provider-M2M client secret
 * Optional:
 *   SCRIBE_E2E_ENABLED=false     explicit opt-out
 */
import 'dotenv/config'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  ScribeClient,
  ScribeStreamClient,
  ServiceUnavailableError,
  WS_CONNECT_PATH,
} from '../../src'
import type { ScribeStreamState, SttTranscriptSegment } from '../../src'
import { mintAttachTicket, mintM2mProviderToken, ProviderGrantError } from './scribe-auth'

const scribeBaseUrl = process.env.SCRIBE_E2E_BASE_URL
const identityBaseUrl = process.env.SCRIBE_E2E_IDENTITY_BASE_URL
const workspaceId = process.env.SCRIBE_E2E_WORKSPACE_ID
const providerEmail = process.env.SCRIBE_E2E_PROVIDER_EMAIL
const clientId = process.env.SCRIBE_M2M_CLIENT_ID
const clientSecret = process.env.SCRIBE_M2M_CLIENT_SECRET
const explicitlyDisabled = process.env.SCRIBE_E2E_ENABLED === 'false'

const hasCreds =
  Boolean(
    scribeBaseUrl && identityBaseUrl && workspaceId && providerEmail && clientId && clientSecret
  ) && !explicitlyDisabled

if (!hasCreds) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scribe streaming e2e] skipped — set SCRIBE_E2E_BASE_URL, ' +
      'SCRIBE_E2E_IDENTITY_BASE_URL, SCRIBE_E2E_WORKSPACE_ID, ' +
      'SCRIBE_E2E_PROVIDER_EMAIL, SCRIBE_M2M_CLIENT_ID, SCRIBE_M2M_CLIENT_SECRET to run.'
  )
}

/** Global `WebSocket` is required (Node ≥ 22 ships one; the SDK uses it by default). */
const hasWebSocket = typeof globalThis.WebSocket === 'function'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Generate a mono 16-bit PCM sine tone. 16 kHz, 440 Hz, `durationMs` long —
 * returned as one `Uint8Array` (little-endian samples), the same PCM16 shape a
 * real recorder would emit.
 */
function synthPcm16(durationMs: number): Uint8Array {
  const sampleRate = 16_000
  const freq = 440
  const nSamples = Math.floor((sampleRate * durationMs) / 1000)
  const buf = new ArrayBuffer(nSamples * 2)
  const view = new DataView(buf)
  for (let i = 0; i < nSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 0.3 * 32767)
    view.setInt16(i * 2, sample, true)
  }
  return new Uint8Array(buf)
}

/**
 * Plain HTTP GET to the gameserver's WS path to tell "network can't reach the
 * host" apart from "reached it but the WS didn't open". Any HTTP status ⇒
 * reachable (the worker answers 4xx/426 to a non-upgrade GET); a thrown
 * fetch error ⇒ the host is unreachable from here (e.g. a staging ALB that
 * doesn't allow the CI runner's egress IPs).
 */
async function probeHost(host: string): Promise<string> {
  try {
    const r = await fetch(`https://${host}${WS_CONNECT_PATH}`, { method: 'GET' })
    return `reachable (HTTP ${r.status})`
  } catch (e) {
    return `UNREACHABLE (${e instanceof Error ? e.message : String(e)})`
  }
}

/**
 * Poll `getState()` until it reaches `target`. `connect()` resolves once the
 * socket is created (not on open), so the real WS transitions connecting →
 * streaming asynchronously. Throws the captured error if the client fails; on
 * timeout, probes host reachability so the failure is diagnosable.
 */
async function waitForState(
  client: ScribeStreamClient,
  target: ScribeStreamState,
  timeoutMs: number,
  errors: Error[],
  host: string
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
  const probe = host ? await probeHost(host) : 'no host'
  const errMsgs = errors.map(e => e.message).join('; ') || 'none'
  throw new Error(
    `timed out waiting for state="${target}" (last="${client.getState()}"; ` +
      `errors=[${errMsgs}]; host-probe: ${probe})`
  )
}

describe.runIf(hasCreds)('Scribe streaming e2e (M2M → create → allocate → stream → end)', () => {
  let providerToken: string

  beforeAll(async () => {
    if (!hasWebSocket) {
      return
    }
    // 1. Per-clinician provider token via act-as-by-email. A missing grant is a
    // fixture problem, not a code bug — surface it loudly.
    try {
      providerToken = await mintM2mProviderToken({
        identityBaseUrl: identityBaseUrl!,
        clientId: clientId!,
        clientSecret: clientSecret!,
        providerEmail: providerEmail!,
      })
    } catch (err) {
      if (err instanceof ProviderGrantError) {
        throw new Error(
          `[scribe streaming e2e] ${err.message} — the test provider email needs an ` +
            `ACTIVE (non-MFA) provider_access_grant in workspace ${workspaceId}. ` +
            `Create a fixture grant, then re-run.`
        )
      }
      throw err
    }
    expect(providerToken.length).toBeGreaterThan(0)
  }, 30_000)

  it('runs the full in-person path with synthetic PCM16', async () => {
    if (!hasWebSocket) {
      // eslint-disable-next-line no-console
      console.warn('[scribe streaming e2e] no global WebSocket (Node < 22) — skipping stream leg.')
      return
    }

    // 2. Create + allocate as the clinician (provider token is the bearer).
    const scribe = new ScribeClient({
      baseUrl: scribeBaseUrl!,
      token: providerToken,
      workspaceId: workspaceId!,
    })
    const session = await scribe.createSession({
      external_id: `sdk-stream-e2e-${Date.now()}`,
      metadata: { source: 'scribe-typescript-sdk streaming e2e' },
    })
    expect(session.id).toBeTruthy()

    // 3 + 4. Stream via the SDK, wiring the two seams to the real mints.
    // NOTE: `allocate` has a per-session cooldown (phase 12), so the seam is the
    // SINGLE allocate call — do NOT pre-allocate separately or the second call
    // 503s ("Too many allocation requests for this session"). We capture the
    // host the seam resolved to for a post-connect assertion.
    const turns: SttTranscriptSegment[] = []
    const states: ScribeStreamState[] = []
    const errors: Error[] = []
    let allocatedHost = ''
    const client = new ScribeStreamClient({
      sessionId: session.id,
      ticketProvider: async sid =>
        mintAttachTicket({
          identityBaseUrl: identityBaseUrl!,
          subjectToken: providerToken,
          sessionId: sid,
        }),
      allocateProvider: async sid => {
        const a = await scribe.allocate(sid)
        allocatedHost = a.host
        return { host: a.host, expiresAt: a.expires_at }
      },
      onTurn: seg => turns.push(seg),
      onStateChange: s => states.push(s),
      onError: e => errors.push(e),
      // Short keepalive so a pong round-trips within the test window.
      keepaliveIntervalMs: 2_000,
    })

    try {
      try {
        await client.connect()
      } catch (err) {
        // Allocate may legitimately 503 if the Fleet is exhausted — tolerate it
        // and skip the stream leg (the M2M + CRUD path is still proven).
        if (err instanceof ServiceUnavailableError) {
          // eslint-disable-next-line no-console
          console.warn(
            `[scribe streaming e2e] allocate 503 (retry after ${err.retryAfterSeconds}s) — ` +
              `Fleet exhausted; skipping the stream leg.`
          )
          return
        }
        throw err
      }
      expect(allocatedHost.length).toBeGreaterThan(0)
      // eslint-disable-next-line no-console
      console.warn(`[scribe streaming e2e] allocated host=${allocatedHost}; awaiting attach…`)
      // Attached: wait for the 101 upgrade → open → streaming transition
      // (connect() resolves on socket creation, not on open). Generous timeout
      // for a possible GameServer cold-start.
      await waitForState(client, 'streaming', 60_000, errors, allocatedHost)
      expect(client.getState()).toBe('streaming')

      // Feed ~4s of synthetic PCM16 in 100 ms chunks.
      for (let i = 0; i < 40; i++) {
        client.sendAudio(synthPcm16(100))
        await sleep(100)
      }

      // Give the worker a moment to ack + pong (+ maybe transcribe the tone).
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (client.getAckedBytes() > 0 && client.getLastPongAt() > 0) {
          break
        }
        await sleep(250)
      }

      // Core assertions: the worker acked our audio and answered a keepalive.
      expect(client.getAckedBytes()).toBeGreaterThan(0)
      expect(client.getLastPongAt()).toBeGreaterThan(0)
      // Transcripts from a pure tone are best-effort; log for visibility.
      // eslint-disable-next-line no-console
      console.warn(
        `[scribe streaming e2e] acked=${client.getAckedBytes()}B, ` +
          `pong=${client.getLastPongAt() > 0}, transcripts=${turns.length}`
      )
      expect(errors).toHaveLength(0)
    } finally {
      client.end()
    }

    // 5. Clean end.
    expect(client.getState()).toBe('ended')
  }, 120_000)

  afterAll(() => {
    // Nothing to tear down: sessions expire on their own; end() closed the WS.
  })
})
