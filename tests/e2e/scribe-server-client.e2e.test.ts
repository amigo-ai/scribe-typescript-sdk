/**
 * End-to-end coverage of the `ScribeServerClient` backend/M2M surface against the
 * REAL staging identity + Scribe stack (workspace f001e5c8).
 *
 * One block per exposed method, happy + sad:
 *   mintProviderToken (client_credentials + provider_email act-as; per-email
 *   cache; invalid_target; email normalisation) · clearTokenCache · scribe()
 *   accessor · createSession · allocate · mintAttachTicket (token_exchange;
 *   aud/scope/TTL correctness) · prepareConnection.
 *
 * Provider-token cache + isolation are asserted via an injected counting fetch
 * (proves a cached mint makes no `/token` call, a cleared cache re-mints, and a
 * failed mint for another email does not clobber a cached entry).
 *
 * Zero-residue: reuses the pre-provisioned CI provider grant, creates no grants
 * or M2M clients, and only creates `sdk-e2e-*` sessions (auto-reaped).
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { BadRequestError, ScribeError, ServiceUnavailableError } from '../../src'
import type { ScribeServerClient, SessionResponse } from '../../src'
import {
  claimToSet,
  countingFetch,
  decodeJwtPayload,
  e2eExternalId,
  env,
  hasCreds,
  makeServerClient,
  noGrantEmail,
} from './harness'

describe.runIf(hasCreds)(
  'ScribeServerClient e2e (mint / act-as / ticket / prepareConnection)',
  () => {
    let server: ScribeServerClient
    let session: SessionResponse

    beforeAll(async () => {
      server = makeServerClient()
      try {
        await server.mintProviderToken(env.providerEmail!)
      } catch (err) {
        const e = err as ScribeError
        if (e.errorCode === 'invalid_target') {
          throw new Error(
            `[server-client e2e] provider "${env.providerEmail}" has no active grant in ` +
              `workspace ${env.workspaceId}; provision one then re-run.`
          )
        }
        throw err
      }
      session = await server.createSession(env.providerEmail!, {
        external_id: e2eExternalId('server'),
        metadata: { source: 'scribe-typescript-sdk server-client e2e' },
      })
      expect(session.id).toBeTruthy()
    }, 60_000)

    // --- mintProviderToken (happy + shape) -----------------------------------
    it('mintProviderToken(granted email) → a non-empty provider JWT', async () => {
      const token = await server.mintProviderToken(env.providerEmail!)
      expect(typeof token).toBe('string')
      expect(token.split('.').length).toBe(3)
      const claims = decodeJwtPayload(token)
      // Provider token targets the platform API audience with a real expiry.
      expect(typeof claims.exp).toBe('number')
      expect((claims.exp as number) * 1000).toBeGreaterThan(Date.now())
    })

    // --- mintProviderToken (per-email cache, via counting fetch) --------------
    it('caches per email, re-mints after clearTokenCache, and isolates failures', async () => {
      const { fetch: countedFetch, tokenCalls } = countingFetch()
      const s = makeServerClient(countedFetch)

      const a = await s.mintProviderToken(env.providerEmail!)
      expect(tokenCalls()).toBe(1)

      // Cached: no second /token call, same token string returned.
      const b = await s.mintProviderToken(env.providerEmail!)
      expect(tokenCalls()).toBe(1)
      expect(b).toBe(a)

      // Email normalisation: a case/whitespace variant hits the same cache entry.
      const c = await s.mintProviderToken(`  ${env.providerEmail!.toUpperCase()}  `)
      expect(tokenCalls()).toBe(1)
      expect(c).toBe(a)

      // A failed mint for a DIFFERENT (ungranted) email must not evict the cached
      // granted-email entry (no cross-email leakage / clobbering).
      await expect(s.mintProviderToken(noGrantEmail())).rejects.toBeInstanceOf(BadRequestError)
      expect(tokenCalls()).toBe(2)
      const d = await s.mintProviderToken(env.providerEmail!)
      expect(tokenCalls()).toBe(2)
      expect(d).toBe(a)

      // clearTokenCache forces a fresh mint.
      s.clearTokenCache()
      await s.mintProviderToken(env.providerEmail!)
      expect(tokenCalls()).toBe(3)
    }, 60_000)

    // --- mintProviderToken (sad: invalid_target) -----------------------------
    it('mintProviderToken(ungranted email) → 400 invalid_target', async () => {
      try {
        await server.mintProviderToken(noGrantEmail())
        throw new Error('expected invalid_target for an ungranted email')
      } catch (err) {
        expect(err).toBeInstanceOf(BadRequestError)
        const e = err as ScribeError
        expect(e.statusCode).toBe(400)
        expect(e.errorCode).toBe('invalid_target')
      }
    })

    // --- scribe() accessor + createSession + allocate ------------------------
    it('scribe(email) returns a ScribeClient that reads as that clinician', async () => {
      const bound = server.scribe(env.providerEmail!)
      const got = await bound.getSession(session.id)
      expect(got.id).toBe(session.id)
    })

    it('allocate(email, sessionId) → {host, expiresAt} (or 503 when exhausted)', async () => {
      const target = await server.createSession(env.providerEmail!, {
        external_id: e2eExternalId('server-allocate'),
      })
      try {
        const alloc = await server.allocate(env.providerEmail!, target.id)
        expect(typeof alloc.host).toBe('string')
        expect(alloc.host.length).toBeGreaterThan(0)
        expect(() => new Date(alloc.expiresAt).toISOString()).not.toThrow()
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableError)
      }
    }, 60_000)

    // --- mintAttachTicket (token_exchange; aud/scope/TTL) --------------------
    it('mintAttachTicket → a WS-only ticket with aud=scribe-streaming + connect scope + ~5m TTL', async () => {
      const { ticket, expiresAt } = await server.mintAttachTicket(env.providerEmail!, session.id)
      expect(typeof ticket).toBe('string')
      expect(ticket.split('.').length).toBe(3)

      const claims = decodeJwtPayload(ticket)
      const aud = claimToSet(claims.aud)
      const scope = claimToSet(claims.scope ?? claims.scp ?? claims.scopes)

      // aud is the streaming audience; scope is the WS-connect scope (design record
      // + server-client contract). These are tightened against the first CI run.
      expect([...aud].some(a => a.includes('scribe-streaming'))).toBe(true)
      expect(scope.has('scribe:streams:connect')).toBe(true)

      // Session binding: the ticket is bound to this session id.
      const boundId = claims.session_id ?? claims.sid
      if (boundId !== undefined) {
        expect(boundId).toBe(session.id)
      }

      // TTL ~5 min: exp exists, is in the future, and is short-lived (< 30 min).
      expect(typeof claims.exp).toBe('number')
      const msToExpiry = (claims.exp as number) * 1000 - Date.now()
      expect(msToExpiry).toBeGreaterThan(30_000)
      expect(msToExpiry).toBeLessThan(30 * 60_000)
      if (expiresAt) {
        expect(() => new Date(expiresAt).toISOString()).not.toThrow()
      }
    }, 30_000)

    it('mintAttachTicket(arbitrary session) binds the id — validation is deferred to WS-attach', async () => {
      // Observed on staging: `token_exchange` does NOT verify the session exists
      // or is owned at mint time — it binds the requested `session_id` into the
      // ticket and the scribe worker re-verifies ownership/existence at WS attach
      // (by design — see the ScribeServerClient contract). So an arbitrary session
      // id yields a bound ticket rather than a 4xx. (A typed rejection is tolerated
      // too, in case staging ever tightens this to mint-time validation.)
      const unknownId = globalThis.crypto.randomUUID()
      try {
        const { ticket } = await server.mintAttachTicket(env.providerEmail!, unknownId)
        expect(ticket.split('.').length).toBe(3)
        const claims = decodeJwtPayload(ticket)
        const boundId = claims.session_id ?? claims.sid
        if (boundId !== undefined) {
          expect(boundId).toBe(unknownId)
        }
      } catch (err) {
        expect(err).toBeInstanceOf(ScribeError)
        const e = err as ScribeError
        expect(e.statusCode).toBeGreaterThanOrEqual(400)
        expect(e.statusCode).toBeLessThan(500)
      }
    })

    // --- prepareConnection (allocate + ticket bundle) ------------------------
    it('prepareConnection → the browser-safe {sessionId, host, ticket} bundle (or 503)', async () => {
      const target = await server.createSession(env.providerEmail!, {
        external_id: e2eExternalId('server-prepare'),
      })
      try {
        const conn = await server.prepareConnection(env.providerEmail!, target.id)
        expect(conn.sessionId).toBe(target.id)
        expect(typeof conn.host).toBe('string')
        expect(conn.host.length).toBeGreaterThan(0)
        expect(conn.ticket.split('.').length).toBe(3)
        // The bundle must NOT leak the provider JWT or client secret.
        expect(conn.ticket).not.toContain(env.clientSecret!)
      } catch (err) {
        expect(err).toBeInstanceOf(ServiceUnavailableError)
      }
    }, 60_000)
  }
)
