/**
 * Regression guard for the "Illegal invocation" class of bug: native browser
 * APIs (`fetch`, `setTimeout`/`clearTimeout`/`setInterval`/`clearInterval`) throw
 * a TypeError in browsers when called as a BARE/unbound reference (receiver is
 * not `globalThis`). jsdom / Node do NOT enforce this, so these tests install a
 * receiver-checking guard over the global timers: the guard throws when invoked
 * with `this !== globalThis` (exactly what a bare `setTimeout(...)` does in a
 * strict ESM module, where `this` is `undefined`). The SDK must call these via
 * `globalThis.<fn>(...)` (or a `globalThis`-bound reference) so the guard passes.
 *
 * If any timer is reverted to a bare call, the guard throws and these tests fail
 * — catching the bug that a real browser would, which jsdom would miss.
 */
import { describe, expect, it } from 'vitest'
import { HttpClient } from '../src/http'
import type { FetchLike } from '../src/http'
import { TimeoutError } from '../src/errors'
import { streamSessionEvents } from '../src/event-stream'
import { ScribeStreamClient } from '../src/stream-client'
import type { ScribeStreamState } from '../src/stream-client'
import { MockWs } from './mock-ws'

/** Capture the REAL globals before any guard is installed (no fake timers here). */
const REAL = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
}

/**
 * Run `fn` with the four global timer functions replaced by receiver-checking
 * guards. A guard throws if called with `this !== globalThis` (i.e. bare), and
 * otherwise delegates to the real timer so the code under test still works.
 */
async function withTimerReceiverGuard<T>(fn: () => Promise<T>): Promise<T> {
  const makeGuard = (name: string, real: (...args: never[]) => unknown) =>
    function (this: unknown, ...args: never[]): unknown {
      if (this !== globalThis) {
        throw new TypeError(`Illegal invocation: ${name} called with receiver=${String(this)}`)
      }
      return (real as (...a: never[]) => unknown)(...args)
    }
  globalThis.setTimeout = makeGuard('setTimeout', REAL.setTimeout as never) as typeof setTimeout
  globalThis.clearTimeout = makeGuard(
    'clearTimeout',
    REAL.clearTimeout as never
  ) as typeof clearTimeout
  globalThis.setInterval = makeGuard('setInterval', REAL.setInterval as never) as typeof setInterval
  globalThis.clearInterval = makeGuard(
    'clearInterval',
    REAL.clearInterval as never
  ) as typeof clearInterval
  try {
    return await fn()
  } finally {
    Object.assign(globalThis, REAL)
  }
}

const realSleep = (ms: number): Promise<void> =>
  new Promise(resolve => REAL.setTimeout(resolve, ms))

/** Poll (real timers) until the stream client has constructed its mock socket. */
async function waitForWs(): Promise<MockWs> {
  for (let i = 0; i < 500; i++) {
    if (MockWs.instances.length > 0) {
      return MockWs.last()
    }
    await realSleep(1)
  }
  throw new Error('MockWs was never created')
}

/** Build a streaming `Response` whose body emits `chunks` then closes. */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder()
      for (const c of chunks) {
        controller.enqueue(enc.encode(c))
      }
      controller.close()
    },
  })
  return {
    ok: true,
    status: 200,
    statusText: '',
    headers: new Headers(),
    body: stream,
    text: () => Promise.resolve(''),
  } as unknown as Response
}

describe('native-API receiver binding (Illegal-invocation guard)', () => {
  it('http.ts timeout timers are globalThis-bound (request timeout still works)', async () => {
    // Hangs until aborted, so the timeout timer must fire to settle the request.
    const hanging = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason ?? new Error('a')),
          {
            once: true,
          }
        )
      })) as unknown as FetchLike
    const http = new HttpClient({ baseUrl: 'https://x.test', token: 't', fetch: hanging })

    const err = await withTimerReceiverGuard(() =>
      http.request({ method: 'GET', path: '/v1/x', timeoutMs: 20 }).catch((e: unknown) => e)
    )
    // A bare setTimeout would have thrown TypeError inside combineAbortSignal;
    // with globalThis-bound timers the deadline fires and yields TimeoutError.
    expect(err).toBeInstanceOf(TimeoutError)
  })

  it('event-stream reconnect delay timer is globalThis-bound', async () => {
    // First connection: clean EOF with zero events → triggers a backoff delay()
    // (which schedules a timer) before the second connection delivers a terminal
    // frame. Under the guard, an unbound setTimeout in delay() would throw.
    let call = 0
    const fetchImpl: FetchLike = () => {
      call += 1
      return Promise.resolve(
        call === 1
          ? sseResponse([]) // clean EOF, no frames → reconnect path (delay)
          : sseResponse(['event: bot_status\ndata: {"state":"done"}\n\n'])
      )
    }
    const events = await withTimerReceiverGuard(async () => {
      const out: string[] = []
      for await (const ev of streamSessionEvents({
        baseUrl: 'https://x.test',
        workspaceId: 'ws',
        sessionId: 'sess',
        token: 't',
        fetch: fetchImpl,
        maxRetries: 3,
      })) {
        out.push(ev.event)
      }
      return out
    })
    expect(events).toEqual(['bot_status'])
    expect(call).toBe(2) // proves the reconnect (and thus delay timer) ran
  }, 10_000)

  it('stream-client keepalive/reconnect timers are globalThis-bound', async () => {
    MockWs.reset()
    const errors: Error[] = []
    const states: ScribeStreamState[] = []
    const client = new ScribeStreamClient({
      sessionId: 'sess-1',
      ticketProvider: async () => ({ ticket: 't' }),
      allocateProvider: async () => ({ host: 'h', expiresAt: 'e' }),
      webSocketFactory: (url, protocols) => new MockWs(url, protocols),
      onError: e => errors.push(e),
      onStateChange: s => states.push(s),
      keepaliveIntervalMs: 20, // setInterval scheduled on open
      reconnectDelayMs: () => 10_000, // scheduled but won't fire within the test
    })

    await withTimerReceiverGuard(async () => {
      const connectP = client.connect()
      const ws = await waitForWs()
      ws.open() // → startKeepalive() → globalThis.setInterval
      await connectP
      expect(client.getState()).toBe('streaming')
      MockWs.last().serverClose(1012) // try-again → scheduleReconnect() → globalThis.setTimeout
      await realSleep(10)
      client.end() // → clearTimers() → globalThis.clearInterval + clearTimeout
    })

    // No timer call threw "Illegal invocation".
    expect(errors.find(e => /Illegal invocation/.test(e.message))).toBeUndefined()
  })
})
