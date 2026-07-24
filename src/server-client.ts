// Server-side Scribe client for the split-trust integration.
//
// This is the CONFIDENTIAL half of the split-trust model: it runs on the
// customer's backend, holds the provider-M2M `client_id` / `client_secret`, and
// talks to BOTH the Amigo identity service (`/token`) and the Scribe CRUD API.
// It is the counterpart to the browser-side {@link ScribeStreamClient} (the
// public half, which only ever holds a short-lived attach ticket).
//
// It encapsulates the two mints a customer backend must implement:
//   1. `grant_type=client_credentials` + `provider_email` (act-as-by-email) →
//      a per-clinician **provider** access token (aud=api.platform, ~15 min).
//   2. `grant_type=token_exchange` (subject = that provider token) → a WS-only,
//      session-bound **attach ticket** (aud=scribe-streaming,
//      scope=scribe:streams:connect, ~5 min).
// plus session CRUD + allocate (delegated to {@link ScribeClient}).
//
// NEVER import this into a browser bundle: it carries the client secret and mints
// provider JWTs. The browser gets only what {@link prepareConnection} returns.

import { ScribeClient } from './client'
import {
  AuthenticationError,
  BadRequestError,
  ConfigurationError,
  NetworkError,
  PermissionError,
  RateLimitError,
  ScribeError,
  ServerError,
} from './errors'
import type { FetchLike } from './http'
import type { AttachTicket, StreamAllocation } from './stream-client'
import type { CreateSessionRequest, SessionResponse } from './types'

/** Re-mint a provider token this many ms before its real expiry (clock skew). */
const PROVIDER_TOKEN_SKEW_MS = 30_000
/** Fallback provider-token TTL if the mint response omits `expires_in`. */
const DEFAULT_PROVIDER_TTL_S = 900

export interface ScribeServerClientConfig {
  /** Identity `/token` base URL, e.g. `https://api.platform.amigo.ai`. */
  identityBaseUrl: string
  /** Scribe CRUD base URL, e.g. `https://scribe.platform.amigo.ai`. */
  scribeBaseUrl: string
  /** Workspace the provider-M2M client is scoped to. */
  workspaceId: string
  /** Provider-M2M client id (non-secret). */
  clientId: string
  /** Provider-M2M client secret — server-side only, never shipped to a browser. */
  clientSecret: string
  /** Injectable fetch. Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** Extra headers merged into every request (identity + Scribe). */
  defaultHeaders?: Record<string, string>
}

/**
 * The browser-safe bundle produced by {@link ScribeServerClient.prepareConnection}
 * — everything (and ONLY what) the public {@link ScribeStreamClient} needs to
 * attach. The provider JWT and client secret never appear here.
 */
export interface BrowserConnection {
  /** Scribe session id the browser attaches to. */
  sessionId: string
  /** `<gameserver_name>.<scribe-actors-domain>` — the WS routing host. */
  host: string
  /** WS-only attach ticket (aud=scribe-streaming, ~5-min TTL). */
  ticket: string
  /** ISO-8601 expiry of the allocation lease (~2h). */
  hostExpiresAt?: string
  /** ISO-8601 expiry of the attach ticket (~5 min). */
  ticketExpiresAt?: string
}

interface IdentityTokenResponse {
  access_token: string
  expires_in?: number
}

/**
 * Confidential server-side client: mints per-clinician provider tokens
 * (act-as-by-email), does session CRUD + allocate, and mints WS-only attach
 * tickets. The `providerEmail` passed to every method is the logged-in
 * clinician's email, taken from YOUR authenticated app session — never supplied
 * by the browser.
 */
export class ScribeServerClient {
  private readonly identityBaseUrl: string
  private readonly scribeBaseUrl: string
  private readonly workspaceId: string
  private readonly clientId: string
  private readonly clientSecret: string
  private readonly fetchImpl: FetchLike
  private readonly defaultHeaders: Record<string, string>

  /** In-memory provider-token cache, keyed by normalized clinician email. */
  private readonly tokenCache = new Map<string, { token: string; expiresAt: number }>()

  constructor(config: ScribeServerClientConfig) {
    const required: Array<[keyof ScribeServerClientConfig, string]> = [
      ['identityBaseUrl', 'identityBaseUrl'],
      ['scribeBaseUrl', 'scribeBaseUrl'],
      ['workspaceId', 'workspaceId'],
      ['clientId', 'clientId'],
      ['clientSecret', 'clientSecret'],
    ]
    for (const [key, field] of required) {
      if (!config?.[key]) {
        throw new ConfigurationError(`${field} is required`, field)
      }
    }
    const resolvedFetch = config.fetch ?? globalThis.fetch
    if (typeof resolvedFetch !== 'function') {
      throw new ConfigurationError('No fetch implementation available; pass config.fetch', 'fetch')
    }
    this.identityBaseUrl = config.identityBaseUrl.replace(/\/+$/, '')
    this.scribeBaseUrl = config.scribeBaseUrl.replace(/\/+$/, '')
    this.workspaceId = config.workspaceId
    this.clientId = config.clientId
    this.clientSecret = config.clientSecret
    this.fetchImpl = resolvedFetch
    this.defaultHeaders = config.defaultHeaders ?? {}
  }

  /**
   * Mint (or return a cached) per-clinician **provider** access token via the
   * provider-M2M `client_credentials` + `provider_email` (act-as-by-email)
   * grant. Cached in memory per email until shortly before expiry.
   *
   * Throws {@link BadRequestError} with `errorCode === 'invalid_target'` when the
   * clinician has no active, non-MFA grant in the workspace (unknown / pending /
   * revoked / cross-workspace / MFA-required — the MFA carve-out).
   */
  async mintProviderToken(providerEmail: string): Promise<string> {
    const email = normalizeEmail(providerEmail)
    const cached = this.tokenCache.get(email)
    if (cached && cached.expiresAt > Date.now() + PROVIDER_TOKEN_SKEW_MS) {
      return cached.token
    }
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: this.clientId,
      client_secret: this.clientSecret,
      provider_email: email,
    })
    const { access_token, expires_in } = await this.postToken(form)
    const ttlS =
      typeof expires_in === 'number' && expires_in > 0 ? expires_in : DEFAULT_PROVIDER_TTL_S
    this.tokenCache.set(email, { token: access_token, expiresAt: Date.now() + ttlS * 1000 })
    return access_token
  }

  /** Drop any cached provider tokens (e.g. after a secret rotation). */
  clearTokenCache(): void {
    this.tokenCache.clear()
  }

  /**
   * A {@link ScribeClient} bound to `providerEmail` (its bearer is a freshly
   * minted/cached provider token). Use it for reads — transcript, note, summary,
   * checklist, codes — as that clinician.
   */
  scribe(providerEmail: string): ScribeClient {
    return new ScribeClient({
      baseUrl: this.scribeBaseUrl,
      workspaceId: this.workspaceId,
      token: () => this.mintProviderToken(providerEmail),
      fetch: this.fetchImpl,
      defaultHeaders: this.defaultHeaders,
    })
  }

  /** Create a session as `providerEmail` (`POST /v1/{ws}/sessions`). */
  async createSession(
    providerEmail: string,
    input?: CreateSessionRequest
  ): Promise<SessionResponse> {
    return this.scribe(providerEmail).createSession(input)
  }

  /**
   * Allocate a streaming host for a session (exposed separately). Returns
   * `{ host, expiresAt }`. Throws {@link ServiceUnavailableError} (503) with
   * `retryAfterSeconds` on Fleet exhaustion / per-session cooldown.
   *
   * Call this ONCE per (re)connect — `allocate` has a per-session cooldown, so a
   * double-allocate for the same connect will 503.
   */
  async allocate(providerEmail: string, sessionId: string): Promise<StreamAllocation> {
    const { host, expires_at } = await this.scribe(providerEmail).allocate(sessionId)
    return { host, expiresAt: expires_at }
  }

  /**
   * Mint a session-bound, WS-only **attach ticket** via `grant_type=token_exchange`
   * (exposed separately). Returns `{ ticket, expiresAt }`. This is the only
   * credential that ever reaches the browser.
   */
  async mintAttachTicket(providerEmail: string, sessionId: string): Promise<AttachTicket> {
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    const subjectToken = await this.mintProviderToken(providerEmail)
    const form = new URLSearchParams({
      grant_type: 'token_exchange',
      subject_token: subjectToken,
      session_id: sessionId,
    })
    const { access_token, expires_in } = await this.postToken(form)
    return { ticket: access_token, expiresAt: isoFromTtl(expires_in) }
  }

  /**
   * Encapsulating helper: allocate a host AND mint an attach ticket for an
   * existing session, returning the browser-safe {@link BrowserConnection}
   * bundle. The provider token is minted once and reused for both.
   *
   * This backs the browser {@link ScribeStreamClient} `connectionProvider` seam
   * 1:1 — expose it behind an authenticated backend route that verifies the
   * caller owns `sessionId`, then return the result to the browser.
   */
  async prepareConnection(providerEmail: string, sessionId: string): Promise<BrowserConnection> {
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    // Prime the cache so allocate + ticket reuse one provider-token mint.
    await this.mintProviderToken(providerEmail)
    const allocation = await this.allocate(providerEmail, sessionId)
    const { ticket, expiresAt } = await this.mintAttachTicket(providerEmail, sessionId)
    return {
      sessionId,
      host: allocation.host,
      ticket,
      hostExpiresAt: allocation.expiresAt,
      ticketExpiresAt: expiresAt,
    }
  }

  private async postToken(form: URLSearchParams): Promise<IdentityTokenResponse> {
    const url = `${this.identityBaseUrl}/token`
    let response: Response
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
          ...this.defaultHeaders,
        },
        body: form.toString(),
      })
    } catch (err) {
      throw new NetworkError(
        `identity /token request failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : new Error(String(err)),
        { url, method: 'POST' }
      )
    }

    const body = await readJson(response)
    if (!response.ok) {
      throw toIdentityError(response, form.get('grant_type'), body)
    }
    const parsed = body as { access_token?: unknown; expires_in?: unknown } | null
    if (!parsed || typeof parsed.access_token !== 'string' || parsed.access_token.length === 0) {
      throw new ScribeError(`identity /token ${form.get('grant_type')} returned no access_token`, {
        statusCode: response.status,
        context: { body },
      })
    }
    return {
      access_token: parsed.access_token,
      expires_in: typeof parsed.expires_in === 'number' ? parsed.expires_in : undefined,
    }
  }
}

function normalizeEmail(email: string): string {
  if (!email || !email.trim()) {
    throw new ConfigurationError('providerEmail is required', 'providerEmail')
  }
  return email.trim().toLowerCase()
}

function isoFromTtl(expiresIn?: number): string | undefined {
  return typeof expiresIn === 'number' && Number.isFinite(expiresIn)
    ? new Date(Date.now() + expiresIn * 1000).toISOString()
    : undefined
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => '')
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Map an identity `/token` OAuth error (`{ error, error_description }`) to a
 * typed {@link ScribeError}. `errorCode` carries the OAuth `error` string
 * (`invalid_target`, `invalid_scope`, `invalid_request`, ...) for programmatic
 * handling (e.g. the MFA carve-out / no-grant case surfaces as `invalid_target`).
 */
function toIdentityError(response: Response, grantType: string | null, body: unknown): ScribeError {
  const record = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const oauthError = typeof record.error === 'string' ? record.error : undefined
  const description =
    typeof record.error_description === 'string' ? record.error_description : undefined
  const message =
    description ??
    oauthError ??
    `identity /token ${grantType ?? ''} failed (HTTP ${response.status})`.trim()
  const options: Record<string, unknown> = {
    statusCode: response.status,
    errorCode: oauthError,
    context: { body, grantType },
  }
  switch (response.status) {
    case 400:
      return new BadRequestError(message, options)
    case 401:
      return new AuthenticationError(message, options)
    case 403:
      return new PermissionError(message, options)
    case 429: {
      const header = response.headers.get('retry-after')
      if (header && !Number.isNaN(Number(header))) {
        options.retryAfterSeconds = Number(header)
      }
      return new RateLimitError(message, options)
    }
    default:
      return response.status >= 500
        ? new ServerError(message, options)
        : new ScribeError(message, options)
  }
}
