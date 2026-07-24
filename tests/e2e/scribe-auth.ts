/**
 * E2E auth helpers — the customer split-trust M2M flow the SDK's injection seams
 * expect. These live in the test suite (NOT the SDK) on purpose: the SDK is
 * credential-agnostic and never talks to the identity service. A real consumer
 * backend implements exactly these two mints and wires them as the
 * `ticketProvider` / `allocateProvider` seams.
 *
 * Both hit the identity service `/token` endpoint (form-urlencoded), mirroring
 * superscribe-web's server-side mint (`lib/server/scribe-m2m.ts` +
 * `app/api/platform/scribe-token/route.ts`):
 *
 *  1. `mintM2mProviderToken` — `grant_type=client_credentials` + `provider_email`
 *     (act-as-by-email): the confidential provider-M2M client mints a
 *     per-clinician **provider** access token whose `sub` is the clinician's
 *     provider entity (resolved from their active `provider_access_grant` in the
 *     client's workspace). Used server-side only, as the create/allocate bearer
 *     and as the token_exchange subject. 400 `invalid_target` ⇒ the provider has
 *     no active (non-MFA) grant in the workspace.
 *  2. `mintAttachTicket` — `grant_type=token_exchange` (RFC 8693): exchanges the
 *     provider token for a WS-only **attach ticket** (`aud=scribe-streaming`,
 *     scope `scribe:streams:connect`, bound to one `session_id`, ~5-min TTL).
 *     This is the only credential that reaches the "browser" (here, the client).
 */

export interface IdentityTokenResponse {
  access_token: string
  expires_in?: number
}

/** Thrown when the provider has no active (non-MFA) grant for act-as-by-email. */
export class ProviderGrantError extends Error {
  constructor(public readonly providerEmail: string) {
    super(
      `provider "${providerEmail}" is not eligible for act-as delegation ` +
        `(no active grant / unknown / cross-workspace / MFA-required)`
    )
    this.name = 'ProviderGrantError'
  }
}

async function postToken(
  identityBaseUrl: string,
  form: URLSearchParams
): Promise<IdentityTokenResponse> {
  const base = identityBaseUrl.replace(/\/+$/, '')
  const response = await fetch(`${base}/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  })

  if (!response.ok) {
    let errCode: string | undefined
    const body = (await response.json().catch(() => null)) as { error?: unknown } | null
    if (body && typeof body.error === 'string') {
      errCode = body.error
    }
    if (response.status === 400 && errCode === 'invalid_target') {
      throw new ProviderGrantError(form.get('provider_email') ?? '')
    }
    throw new Error(
      `identity /token ${form.get('grant_type')} failed (${response.status}${errCode ? ` ${errCode}` : ''})`
    )
  }

  const body = (await response.json().catch(() => null)) as IdentityTokenResponse | null
  if (!body || typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error(`identity /token ${form.get('grant_type')} returned no access_token`)
  }
  return body
}

/**
 * Mint a per-clinician provider access token via the provider-M2M
 * `client_credentials` grant with `provider_email` (act-as-by-email).
 */
export async function mintM2mProviderToken(opts: {
  identityBaseUrl: string
  clientId: string
  clientSecret: string
  providerEmail: string
}): Promise<string> {
  const form = new URLSearchParams()
  form.set('grant_type', 'client_credentials')
  form.set('client_id', opts.clientId)
  form.set('client_secret', opts.clientSecret)
  form.set('provider_email', opts.providerEmail.trim().toLowerCase())
  const { access_token } = await postToken(opts.identityBaseUrl, form)
  return access_token
}

/**
 * Exchange a provider access token for a session-bound WS-only attach ticket via
 * `grant_type=token_exchange`.
 */
export async function mintAttachTicket(opts: {
  identityBaseUrl: string
  subjectToken: string
  sessionId: string
}): Promise<{ ticket: string; expiresAt?: string }> {
  const form = new URLSearchParams()
  form.set('grant_type', 'token_exchange')
  form.set('subject_token', opts.subjectToken)
  form.set('session_id', opts.sessionId)
  const { access_token, expires_in } = await postToken(opts.identityBaseUrl, form)
  const expiresAt =
    typeof expires_in === 'number' && Number.isFinite(expires_in)
      ? new Date(Date.now() + expires_in * 1000).toISOString()
      : undefined
  return { ticket: access_token, expiresAt }
}
