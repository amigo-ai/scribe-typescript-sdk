import { describe, expect, it } from 'vitest'
import { BadRequestError, ConfigurationError } from '../src/errors'
import { ScribeServerClient } from '../src/server-client'
import { mockFetch } from './test-helpers'

const CONFIG = {
  identityBaseUrl: 'https://id.example.test',
  scribeBaseUrl: 'https://scribe.example.test',
  workspaceId: 'ws-1',
  clientId: 'client-1',
  clientSecret: 'secret-1',
}

function bodyParams(init?: RequestInit): URLSearchParams {
  return new URLSearchParams(String(init?.body))
}

describe('ScribeServerClient construction', () => {
  it('requires every credential/URL field', () => {
    const { fetch } = mockFetch([{}])
    for (const key of [
      'identityBaseUrl',
      'scribeBaseUrl',
      'workspaceId',
      'clientId',
      'clientSecret',
    ]) {
      const bad = { ...CONFIG, fetch, [key]: '' }
      expect(() => new ScribeServerClient(bad)).toThrow(ConfigurationError)
    }
  })
})

describe('mintProviderToken (client_credentials + provider_email)', () => {
  it('POSTs form-urlencoded to identity /token with a normalized email', async () => {
    const { fetch, calls } = mockFetch([{ body: { access_token: 'prov-jwt', expires_in: 900 } }])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    const token = await server.mintProviderToken('  Doctor@Clinic.COM ')

    expect(token).toBe('prov-jwt')
    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe('https://id.example.test/token')
    expect(call.init?.method).toBe('POST')
    const headers = call.init?.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/x-www-form-urlencoded')
    const form = bodyParams(call.init)
    expect(form.get('grant_type')).toBe('client_credentials')
    expect(form.get('client_id')).toBe('client-1')
    expect(form.get('client_secret')).toBe('secret-1')
    expect(form.get('provider_email')).toBe('doctor@clinic.com')
  })

  it('caches the provider token per email (no re-mint within TTL)', async () => {
    const { fetch, calls } = mockFetch([{ body: { access_token: 'prov-jwt', expires_in: 900 } }])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    await server.mintProviderToken('doc@clinic.com')
    await server.mintProviderToken('doc@clinic.com')
    expect(calls).toHaveLength(1)
  })

  it('maps a 400 invalid_target to BadRequestError with errorCode', async () => {
    const { fetch } = mockFetch([
      {
        status: 400,
        body: { error: 'invalid_target', error_description: 'no active grant' },
      },
    ])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    await expect(server.mintProviderToken('mfa@clinic.com')).rejects.toMatchObject({
      constructor: BadRequestError,
      errorCode: 'invalid_target',
      message: 'no active grant',
    })
  })
})

describe('mintAttachTicket (token_exchange)', () => {
  it('mints a provider token then exchanges it for a session-bound ticket', async () => {
    const { fetch, calls } = mockFetch([
      { body: { access_token: 'prov-jwt', expires_in: 900 } },
      { body: { access_token: 'attach-ticket', expires_in: 300 } },
    ])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    const { ticket, expiresAt } = await server.mintAttachTicket('doc@clinic.com', 'sess-9')

    expect(ticket).toBe('attach-ticket')
    expect(typeof expiresAt).toBe('string')
    expect(calls).toHaveLength(2)
    const exchange = bodyParams(calls[1]?.init)
    expect(exchange.get('grant_type')).toBe('token_exchange')
    expect(exchange.get('subject_token')).toBe('prov-jwt')
    expect(exchange.get('session_id')).toBe('sess-9')
  })

  it('requires a sessionId', async () => {
    const { fetch } = mockFetch([{ body: { access_token: 'prov-jwt' } }])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    await expect(server.mintAttachTicket('doc@clinic.com', '')).rejects.toThrow(ConfigurationError)
  })
})

describe('allocate', () => {
  it('mints a provider token then calls Scribe allocate, returning { host, expiresAt }', async () => {
    const { fetch, calls } = mockFetch([
      { body: { access_token: 'prov-jwt', expires_in: 900 } },
      { body: { host: 'gs-7.actors.example', expires_at: '2026-07-23T10:00:00Z' } },
    ])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    const alloc = await server.allocate('doc@clinic.com', 'sess-9')

    expect(alloc).toEqual({ host: 'gs-7.actors.example', expiresAt: '2026-07-23T10:00:00Z' })
    expect(calls[1]?.url).toBe('https://scribe.example.test/v1/ws-1/sessions/sess-9/allocate')
    const authHeader = (calls[1]?.init?.headers as Record<string, string>).Authorization
    expect(authHeader).toBe('Bearer prov-jwt')
  })
})

describe('prepareConnection (encapsulating helper)', () => {
  it('mints once, allocates + tickets, and returns the browser-safe bundle', async () => {
    const { fetch, calls } = mockFetch([
      { body: { access_token: 'prov-jwt', expires_in: 900 } }, // client_credentials
      { body: { host: 'gs-7.actors.example', expires_at: '2026-07-23T10:00:00Z' } }, // allocate
      { body: { access_token: 'attach-ticket', expires_in: 300 } }, // token_exchange
    ])
    const server = new ScribeServerClient({ ...CONFIG, fetch })
    const conn = await server.prepareConnection('doc@clinic.com', 'sess-9')

    // Provider token minted ONCE and reused (cache), so exactly 3 network calls.
    expect(calls).toHaveLength(3)
    expect(conn.sessionId).toBe('sess-9')
    expect(conn.host).toBe('gs-7.actors.example')
    expect(conn.ticket).toBe('attach-ticket')
    expect(conn.hostExpiresAt).toBe('2026-07-23T10:00:00Z')
    expect(typeof conn.ticketExpiresAt).toBe('string')
    // The bundle carries NO provider JWT / secret.
    expect(JSON.stringify(conn)).not.toContain('prov-jwt')
    expect(JSON.stringify(conn)).not.toContain('secret-1')
  })
})
