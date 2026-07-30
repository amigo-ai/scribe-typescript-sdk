import { ConfigurationError, NetworkError, TimeoutError, createApiError } from './errors'

/** A `fetch`-compatible function. Injectable for testing / custom transports. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Auth token supplier. Either a static string or a (possibly async) callback
 * invoked per request so callers can refresh a short-lived provider JWT. The
 * token must carry the `scribe:sessions:write` scope for the CRUD endpoints.
 */
export type TokenProvider = string | (() => string | Promise<string>)

export interface ScribeClientConfig {
  /** Base URL of the Scribe API, e.g. `https://scribe.platform.amigo.ai`. */
  baseUrl: string
  /** Bearer token (or a supplier) carrying `scribe:sessions:write`. */
  token: TokenProvider
  /**
   * Injectable fetch. Defaults to the global `fetch`. Provide a mock in tests
   * or a custom transport in non-standard runtimes.
   */
  fetch?: FetchLike
  /** Optional default headers merged into every request. */
  defaultHeaders?: Record<string, string>
}

export interface RequestOptions {
  method: string
  path: string
  query?: Record<string, string | number | boolean | undefined>
  body?: unknown
  /** Caller abort signal for cancellation. Combined with `timeoutMs` if both set. */
  signal?: AbortSignal
  /**
   * Per-call deadline in ms. When it elapses the request is aborted and a
   * {@link TimeoutError} is thrown. Implemented on top of `AbortSignal`, so it
   * composes with a caller-supplied `signal` (whichever fires first wins).
   */
  timeoutMs?: number
}

/**
 * Compose a caller {@link AbortSignal} with a per-call timeout into a single
 * signal. Returns the combined signal, a `cleanup()` to clear the timer +
 * listener, and `timedOut()` to distinguish a deadline from a caller abort.
 *
 * Uses a linked {@link AbortController} rather than `AbortSignal.any` +
 * `AbortSignal.timeout` so the timeout reason is inspectable and the helper
 * works on any runtime with `AbortController` (all supported Node + browsers).
 */
export function combineAbortSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number | undefined
): { signal: AbortSignal | undefined; cleanup: () => void; timedOut: () => boolean } {
  if (timeoutMs === undefined) {
    return { signal, cleanup: () => {}, timedOut: () => false }
  }
  const controller = new AbortController()
  // A single exclusive winner: whichever of the caller-abort / timeout fires
  // first settles the controller; the other becomes a no-op. This prevents a
  // late timer from mislabeling a caller-abort as a timeout, and disarms the
  // timer the moment the caller aborts.
  let winner: 'timeout' | 'abort' | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = () => {
    if (winner) {
      return
    }
    winner = 'abort'
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    controller.abort((signal as AbortSignal).reason)
  }
  const onTimeout = () => {
    if (winner) {
      return
    }
    winner = 'timeout'
    controller.abort(new Error(`Request timed out after ${timeoutMs}ms`))
  }
  if (signal?.aborted) {
    winner = 'abort'
    controller.abort(signal.reason)
  } else {
    timer = setTimeout(onTimeout, timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
  }
  const cleanup = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    signal?.removeEventListener('abort', onAbort)
  }
  return { signal: controller.signal, cleanup, timedOut: () => winner === 'timeout' }
}

/**
 * Await `promise`, but reject as soon as `signal` aborts. Used so a hung token
 * provider (or any pre-fetch async work) is still bounded by the composed
 * deadline — the underlying work is not cancelled, we just stop awaiting it.
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new Error('aborted'))
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/** True when `signal` was aborted by an `AbortSignal.timeout(...)` (reason is a TimeoutError). */
function isTimeoutAbort(signal: AbortSignal | undefined): boolean {
  return (
    signal?.aborted === true &&
    (signal.reason as { name?: unknown } | undefined)?.name === 'TimeoutError'
  )
}

/**
 * Small configurable HTTP transport: resolves the base URL, injects the
 * `Authorization: Bearer <token>` header, serializes JSON, and maps non-2xx
 * responses to typed {@link ScribeError}s.
 */
export class HttpClient {
  private readonly baseUrl: string
  private readonly token: TokenProvider
  private readonly fetchImpl: FetchLike
  private readonly defaultHeaders: Record<string, string>

  constructor(config: ScribeClientConfig) {
    if (!config?.baseUrl) {
      throw new ConfigurationError('baseUrl is required', 'baseUrl')
    }
    if (!config.token) {
      throw new ConfigurationError('token is required', 'token')
    }
    const resolvedFetch = config.fetch ?? globalThis.fetch
    if (typeof resolvedFetch !== 'function') {
      throw new ConfigurationError('No fetch implementation available; pass config.fetch', 'fetch')
    }
    this.baseUrl = config.baseUrl.replace(/\/+$/, '')
    this.token = config.token
    // Bind to globalThis: native `fetch` must run with `this === globalThis`.
    // Called as `this.fetchImpl(...)` an unbound reference would run with
    // `this === HttpClient`, which throws "Illegal invocation" in browsers
    // (TypeError). The guard above ensures `resolvedFetch` is callable, so
    // `.bind` is safe; this covers both the default `globalThis.fetch` and any
    // injected `config.fetch` (harmless for already-bound / arrow functions).
    this.fetchImpl = resolvedFetch.bind(globalThis)
    this.defaultHeaders = config.defaultHeaders ?? {}
  }

  private async resolveToken(): Promise<string> {
    return typeof this.token === 'function' ? this.token() : this.token
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`
    let url = `${this.baseUrl}${normalizedPath}`
    if (query) {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) {
          params.append(key, String(value))
        }
      }
      const qs = params.toString()
      if (qs) {
        url += `?${qs}`
      }
    }
    return url
  }

  async request<T>(options: RequestOptions): Promise<T> {
    const url = this.buildUrl(options.path, options.query)

    // Compose the deadline BEFORE token resolution and keep it armed through the
    // body read, so a hung token provider or a server that sends headers then
    // stalls the body is still bounded by `timeoutMs`.
    const { signal, cleanup, timedOut } = combineAbortSignal(options.signal, options.timeoutMs)
    const isTimeout = (): boolean => timedOut() || isTimeoutAbort(options.signal)

    try {
      // Bound token resolution by the deadline too (not just the fetch). Only
      // the timeout case is re-typed; a genuine token-provider error propagates
      // unchanged.
      let token: string
      try {
        token = await raceAbort(this.resolveToken(), signal)
      } catch (err) {
        if (isTimeout()) {
          throw new TimeoutError(
            `Request timed out after ${options.timeoutMs}ms`,
            options.timeoutMs,
            {
              url,
              method: options.method,
            }
          )
        }
        throw err
      }

      const headers: Record<string, string> = {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        ...this.defaultHeaders,
      }
      const init: RequestInit = { method: options.method, headers, signal }
      if (options.body !== undefined) {
        headers['Content-Type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }

      let response: Response
      try {
        response = await this.fetchImpl(url, init)
      } catch (err) {
        if (isTimeout()) {
          throw new TimeoutError(
            `Request timed out after ${options.timeoutMs}ms`,
            options.timeoutMs,
            {
              url,
              method: options.method,
            }
          )
        }
        throw new NetworkError(
          `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          { url, method: options.method }
        )
      }

      // Body read runs under the same deadline; an abort here (headers arrived,
      // body stalled) is translated to TimeoutError just like a connect abort.
      let payload: unknown
      try {
        payload = await safeParse(response)
      } catch (err) {
        if (isTimeout()) {
          throw new TimeoutError(
            `Request timed out after ${options.timeoutMs}ms`,
            options.timeoutMs,
            {
              url,
              method: options.method,
            }
          )
        }
        throw new NetworkError(
          `Response body read failed: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : new Error(String(err)),
          { url, method: options.method }
        )
      }

      if (!response.ok) {
        throw createApiError(response, payload)
      }
      return payload as T
    } finally {
      cleanup()
    }
  }
}

async function safeParse(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) {
    return undefined
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
