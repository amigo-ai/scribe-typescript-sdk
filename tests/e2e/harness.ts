/**
 * Shared harness for the Scribe resource-API E2E suites.
 *
 * Centralises the staging env + credential gating, the `ScribeServerClient`
 * factory, JWT decoding (for ticket aud/scope/TTL assertions), a session
 * tracker for zero-residue discipline, and small polling helpers — so every
 * resource-API suite reuses the same CI staging M2M creds and teardown.
 *
 * Credentials (GitHub repo secrets/vars, mirrored into a local `.env`):
 *   SCRIBE_E2E_BASE_URL          scribe CRUD base URL (create/allocate/reads)
 *   SCRIBE_E2E_IDENTITY_BASE_URL identity `/token` base URL (mints)
 *   SCRIBE_E2E_WORKSPACE_ID      workspace id (the M2M client's workspace)
 *   SCRIBE_E2E_PROVIDER_EMAIL    a provider WITH an active grant in that workspace
 *   SCRIBE_M2M_CLIENT_ID         provider-M2M client id
 *   SCRIBE_M2M_CLIENT_SECRET     provider-M2M client secret (never logged)
 * Optional:
 *   SCRIBE_E2E_ENABLED=false     explicit opt-out
 */
import 'dotenv/config'
import { ScribeClient, ScribeServerClient } from '../../src'
import type { FetchLike } from '../../src'

export const env = {
  scribeBaseUrl: process.env.SCRIBE_E2E_BASE_URL,
  identityBaseUrl: process.env.SCRIBE_E2E_IDENTITY_BASE_URL,
  workspaceId: process.env.SCRIBE_E2E_WORKSPACE_ID,
  providerEmail: process.env.SCRIBE_E2E_PROVIDER_EMAIL,
  clientId: process.env.SCRIBE_M2M_CLIENT_ID,
  clientSecret: process.env.SCRIBE_M2M_CLIENT_SECRET,
}

const explicitlyDisabled = process.env.SCRIBE_E2E_ENABLED === 'false'

/** True when every required credential is present and the suite is not opted out. */
export const hasCreds =
  Boolean(
    env.scribeBaseUrl &&
    env.identityBaseUrl &&
    env.workspaceId &&
    env.providerEmail &&
    env.clientId &&
    env.clientSecret
  ) && !explicitlyDisabled

/** Prefix for every session/identifier this phase creates on staging (identifiable + reaper-eligible). */
export const E2E_PREFIX = 'sdk-e2e'

if (!hasCreds) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scribe resource-api e2e] skipped — set SCRIBE_E2E_BASE_URL, ' +
      'SCRIBE_E2E_IDENTITY_BASE_URL, SCRIBE_E2E_WORKSPACE_ID, SCRIBE_E2E_PROVIDER_EMAIL, ' +
      'SCRIBE_M2M_CLIENT_ID, SCRIBE_M2M_CLIENT_SECRET to run.'
  )
}

// ---------------------------------------------------------------------------
// Provider-JWT (token) gating — the GA 0.4.0 staging E2E (phases 02–08).
//
// Unlike the M2M-credential suites above (which mint their own provider token
// via `ScribeServerClient`), the GA post-visit-mutation suite drives the raw
// `ScribeClient` with a real provider JWT supplied out-of-band in
// `SCRIBE_E2E_TOKEN` (obtained via the human-in-the-loop email-OTP flow; the
// token is short-lived ~15 min). It NEVER mints or hardcodes credentials, and
// self-skips (does not fail) when `SCRIBE_E2E_TOKEN` is absent.
// ---------------------------------------------------------------------------
// Host URLs are supplied by the CI workflow's `env:` block (repository
// variables with staging defaults) and read here from `process.env`; the
// literals below are only a local-run fallback. NOTE: the identity (OTP/token)
// host is `api-staging`, NOT `identity-staging`.
// The host URLs are hard PREREQUISITES — no inline defaults. They come from the
// injected env vars ONLY (CI supplies them from repository variables, gated by a
// fail-fast preflight; local runs must export them). The staging identity/OTP
// host is `api-staging`, NOT `identity-staging`.
export const tokenEnv = {
  /** Scribe CRUD base URL (from `SCRIBE_E2E_BASE_URL`; required at use). */
  baseUrl: process.env.SCRIBE_E2E_BASE_URL,
  /** Identity `/token` base URL (from `SCRIBE_E2E_IDENTITY_BASE_URL`). */
  identityBaseUrl: process.env.SCRIBE_E2E_IDENTITY_BASE_URL,
  /** Pre-minted provider JWT (aud=api.platform, carries `workspace_id`). */
  token: process.env.SCRIBE_E2E_TOKEN,
  /** Workspace id; falls back to the token's `workspace_id` claim when unset. */
  workspaceId: process.env.SCRIBE_E2E_WORKSPACE_ID,
}

/** True when a provider JWT is present and the suite is not opted out. */
export const hasToken = Boolean(tokenEnv.token) && !explicitlyDisabled

if (!hasToken) {
  // eslint-disable-next-line no-console
  console.warn(
    '[scribe ga token e2e] skipped — set SCRIBE_E2E_TOKEN (a provider JWT) to run; ' +
      'SCRIBE_E2E_BASE_URL and SCRIBE_E2E_IDENTITY_BASE_URL are then required ' +
      '(SCRIBE_E2E_WORKSPACE_ID optional — falls back to the token claim).'
  )
}

/** The workspace id for the token suite — explicit env, else the token's `workspace_id` claim. */
export function resolveTokenWorkspaceId(): string {
  if (tokenEnv.workspaceId) {
    return tokenEnv.workspaceId
  }
  const payload = decodeJwtPayload(tokenEnv.token!)
  const ws = payload.workspace_id ?? payload.workspaceId
  if (typeof ws !== 'string' || !ws) {
    throw new Error(
      'SCRIBE_E2E_WORKSPACE_ID is unset and the token carries no `workspace_id` claim'
    )
  }
  return ws
}

/**
 * A raw {@link ScribeClient} bound to the pre-minted provider JWT via an ASYNC
 * token provider (exercises the async `TokenProvider` seam the web depends on).
 */
export function makeTokenClient(): ScribeClient {
  if (!tokenEnv.baseUrl) {
    // Hard prerequisite: with a token present but no base URL the suite must
    // fail loudly (token-absence is the only clean-skip condition).
    throw new Error('SCRIBE_E2E_BASE_URL is required to run the GA token e2e suite')
  }
  return new ScribeClient({
    baseUrl: tokenEnv.baseUrl,
    workspaceId: resolveTokenWorkspaceId(),
    // Async supplier (not a static string) on purpose — mirrors the web's
    // short-lived-token refresh seam.
    token: async () => tokenEnv.token!,
  })
}

/** A unique, identifiable `external_id` for a throwaway session. */
export function e2eExternalId(tag: string): string {
  return `${E2E_PREFIX}-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/** A placeholder email that is guaranteed NOT to have a grant (drives `invalid_target`). */
export function noGrantEmail(): string {
  return `${E2E_PREFIX}-nogrant-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`
}

/** A random UUID for not-found probes (Node ≥ 18 / browser both expose crypto.randomUUID). */
export function randomUuid(): string {
  return globalThis.crypto.randomUUID()
}

/** Build a `ScribeServerClient` against staging. Pass a `fetch` to spy on identity calls. */
export function makeServerClient(fetchImpl?: FetchLike): ScribeServerClient {
  return new ScribeServerClient({
    identityBaseUrl: env.identityBaseUrl!,
    scribeBaseUrl: env.scribeBaseUrl!,
    workspaceId: env.workspaceId!,
    clientId: env.clientId!,
    clientSecret: env.clientSecret!,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  })
}

/**
 * A `fetch` wrapper that counts calls to the identity `/token` endpoint. Used to
 * prove the provider-token cache re-uses a mint (no redundant network calls) and
 * that `clearTokenCache()` forces a re-mint.
 */
export function countingFetch(): { fetch: FetchLike; tokenCalls: () => number } {
  let tokenCalls = 0
  const wrapped: FetchLike = (input, init) => {
    if (typeof input === 'string' && input.includes('/token')) {
      tokenCalls += 1
    }
    return globalThis.fetch(input, init)
  }
  return { fetch: wrapped, tokenCalls: () => tokenCalls }
}

/** Decode a JWT's payload (no signature verification — for aud/scope/exp assertions only). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split('.')
  const payload = parts[1]
  if (!payload) {
    throw new Error('not a JWT')
  }
  const json = Buffer.from(payload, 'base64url').toString('utf8')
  return JSON.parse(json) as Record<string, unknown>
}

/**
 * Normalise a JWT claim that may be a string, a space-delimited string, or an
 * array (aud / scope are all spelled differently across issuers) into a set.
 */
export function claimToSet(value: unknown): Set<string> {
  if (Array.isArray(value)) {
    return new Set(value.map(String))
  }
  if (typeof value === 'string') {
    return new Set(value.split(/[\s]+/).filter(Boolean))
  }
  return new Set()
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// Zero-residue teardown
//
// The e2e suites create ad-hoc `sdk-e2e-*` sessions. A never-streamed session
// is failed by the backend's no-activity watchdog ~5 min later, so on a SHARED
// provider those pile up as "failed" sessions (114 observed on the staging
// `caly@amigo.ai` provider). To leave zero residue, every suite tracks the ids
// it creates and cancels them in `afterAll` via the provider-scoped client.
//
// There is no session-delete endpoint; `cancelSession` (guarded → `cancelled`,
// a terminal state) is the clean way to retire a session so the watchdog never
// touches it. Teardown is BEST-EFFORT: a session that is already terminal
// (`cancelled` / `completed` / `failed`, or a streamed+ended `in-review` that
// can't transition) returns 409, and a missing/unowned id returns 404 — both
// are swallowed so teardown is idempotent and NEVER fails the suite.
// ---------------------------------------------------------------------------

/** HTTP statuses that mean "already retired / nothing to cancel" — safely ignored. */
const TEARDOWN_IGNORABLE_STATUSES = new Set([404, 409])

/**
 * Best-effort cancel of every session id, in order, via the provider-scoped
 * `client`. Swallows terminal/not-found rejections (and logs anything else) so
 * teardown is idempotent and never throws — it must never fail an `afterAll`.
 */
export async function teardownSessions(
  client: ScribeClient,
  sessionIds: Iterable<string>,
  label: string
): Promise<void> {
  const ids = [...new Set(sessionIds)]
  if (ids.length === 0) {
    return
  }
  let cancelled = 0
  let alreadyTerminal = 0
  const failures: string[] = []
  for (const id of ids) {
    try {
      await client.cancelSession(id)
      cancelled += 1
    } catch (err) {
      const e = err as { statusCode?: number; errorCode?: string }
      if (typeof e.statusCode === 'number' && TEARDOWN_IGNORABLE_STATUSES.has(e.statusCode)) {
        // Already terminal (409) or gone/unowned (404) — nothing to do.
        alreadyTerminal += 1
        continue
      }
      // Any other error is non-fatal to teardown; record it for visibility.
      failures.push(`${id} (${e.statusCode ?? 'n/a'} ${e.errorCode ?? 'error'})`)
    }
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[${label}] teardown: cancelled ${cancelled}/${ids.length} session(s) ` +
      `(${alreadyTerminal} already terminal)` +
      (failures.length > 0 ? `; could not cancel: ${failures.join(', ')}` : '')
  )
}

/** Tracks created session ids and cancels them (best-effort) on teardown. */
export interface SessionTracker {
  /** Record a created session (returns it unchanged for inline chaining). */
  track<T extends { id: string }>(session: T): T
  /** Record a bare session id. */
  add(id: string): void
  /** All tracked ids (insertion order, de-duplicated). */
  ids(): string[]
  /** Best-effort `cancelSession` of every tracked id via `client`; never throws. */
  teardown(client: ScribeClient): Promise<void>
}

/**
 * Create a {@link SessionTracker} for a suite. `label` is used in the teardown
 * log line so each suite's residue is attributable.
 */
export function createSessionTracker(label: string): SessionTracker {
  const ids: string[] = []
  return {
    track(session) {
      ids.push(session.id)
      return session
    },
    add(id) {
      ids.push(id)
    },
    ids() {
      return [...ids]
    },
    teardown(client) {
      return teardownSessions(client, ids, label)
    },
  }
}

/**
 * Generate a mono 16-bit PCM sine tone (16 kHz, 440 Hz, `durationMs` long) as one
 * little-endian `Uint8Array` — the same PCM16 shape a real recorder emits. Used
 * to drive a live session for the resource-API lifecycle test (headless CI has
 * no mic).
 */
export function synthPcm16(durationMs: number): Uint8Array {
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
