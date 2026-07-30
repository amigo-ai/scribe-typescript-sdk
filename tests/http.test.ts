/**
 * Regression coverage for the fetch-receiver binding in `HttpClient`.
 *
 * Native `fetch` must run with `this === globalThis`; calling it as
 * `this.fetchImpl(...)` from an UNBOUND reference runs it with
 * `this === HttpClient`, which throws "Illegal invocation" (TypeError) in
 * browsers — no request ever leaves the page. The constructor binds the
 * resolved fetch to `globalThis` to prevent this; these tests fail if that bind
 * is removed.
 */
import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/http'
import type { FetchLike } from '../src/http'
import { makeResponse } from './test-helpers'

const CFG = { baseUrl: 'https://scribe.example.test', token: 't' }

describe('HttpClient fetch receiver binding', () => {
  it('invokes the injected fetch bound to globalThis, not the HttpClient instance', async () => {
    let receiver: unknown = 'unset'
    // A non-arrow function so the call-site `this` is observable unless bound.
    const spy = function (this: unknown) {
      receiver = this
      return Promise.resolve(makeResponse({ status: 200, body: { ok: true } }))
    } as unknown as FetchLike

    const http = new HttpClient({ ...CFG, fetch: spy })
    await http.request({ method: 'GET', path: '/v1/ping' })

    // With the `.bind(globalThis)` fix the receiver is globalThis — NOT the
    // client instance (which is what an unbound `this.fetchImpl(...)` would use).
    expect(receiver).toBe(globalThis)
    expect(receiver instanceof HttpClient).toBe(false)
  })

  it('does not throw "Illegal invocation" for a native-like fetch requiring this===globalThis', async () => {
    // Mimics the browser's native `fetch`: throws unless invoked on globalThis.
    const nativeLike = function (this: unknown) {
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation")
      }
      return Promise.resolve(makeResponse({ status: 200, body: { id: 'sess-1' } }))
    } as unknown as FetchLike

    const http = new HttpClient({ ...CFG, fetch: nativeLike })
    // Without the bind this rejects (TypeError → wrapped NetworkError); with it,
    // the request resolves normally.
    await expect(http.request({ method: 'GET', path: '/v1/ping' })).resolves.toBeDefined()
  })
})
