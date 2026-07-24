import { ConfigurationError, NetworkError, createApiError } from './errors'

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
  signal?: AbortSignal
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
    this.fetchImpl = resolvedFetch
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
    const token = await this.resolveToken()

    const headers: Record<string, string> = {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...this.defaultHeaders,
    }

    const init: RequestInit = {
      method: options.method,
      headers,
      signal: options.signal,
    }

    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(options.body)
    }

    let response: Response
    try {
      response = await this.fetchImpl(url, init)
    } catch (err) {
      throw new NetworkError(
        `Network request failed: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : new Error(String(err)),
        { url, method: options.method }
      )
    }

    if (!response.ok) {
      const body = await safeParse(response)
      throw createApiError(response, body)
    }

    return (await safeParse(response)) as T
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
