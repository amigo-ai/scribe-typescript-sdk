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
import { TimeoutError } from '../src/errors'
import { makeResponse } from './test-helpers'

const CFG = { baseUrl: 'https://scribe.example.test', token: 't' }

/** A fetch that never resolves until its signal aborts (then rejects with the reason). */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal
    signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    })
  })) as unknown as FetchLike

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

describe('HttpClient timeout handling', () => {
  it('maps a per-call timeoutMs to TimeoutError when the request hangs', async () => {
    const http = new HttpClient({ ...CFG, fetch: hangingFetch })
    const err = await http
      .request({ method: 'GET', path: '/v1/ping', timeoutMs: 20 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
    expect((err as TimeoutError).timeoutMs).toBe(20)
  })

  it('maps a caller AbortSignal.timeout(ms) to TimeoutError (documented equivalence)', async () => {
    const http = new HttpClient({ ...CFG, fetch: hangingFetch })
    const err = await http
      .request({ method: 'GET', path: '/v1/ping', signal: AbortSignal.timeout(20) })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('times out a hung token provider (deadline armed before token resolution)', async () => {
    const http = new HttpClient({
      baseUrl: CFG.baseUrl,
      // Token provider never resolves; fetch must never be reached.
      token: () => new Promise<string>(() => {}),
      fetch: (() => Promise.reject(new Error('fetch should not run'))) as unknown as FetchLike,
    })
    const err = await http
      .request({ method: 'GET', path: '/v1/ping', timeoutMs: 20 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('times out when the server sends headers then stalls the body', async () => {
    // Headers arrive immediately; the body read (text()) only settles on abort.
    const stallingFetch = ((_url: string, init?: RequestInit) => {
      const signal = init?.signal
      const res = {
        ok: true,
        status: 200,
        statusText: '',
        headers: new Headers(),
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
              once: true,
            })
          }),
      } as unknown as Response
      return Promise.resolve(res)
    }) as unknown as FetchLike

    const http = new HttpClient({ ...CFG, fetch: stallingFetch })
    const err = await http
      .request({ method: 'GET', path: '/v1/ping', timeoutMs: 20 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('does not time out a fast request', async () => {
    const fast = (() =>
      Promise.resolve(makeResponse({ status: 200, body: { id: 'x' } }))) as unknown as FetchLike
    const http = new HttpClient({ ...CFG, fetch: fast })
    await expect(
      http.request({ method: 'GET', path: '/v1/ping', timeoutMs: 5_000 })
    ).resolves.toEqual({ id: 'x' })
  })
})
