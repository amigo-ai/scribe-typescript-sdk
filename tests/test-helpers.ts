import { vi } from 'vitest'
import type { FetchLike } from '../src/http'

export interface MockResponseSpec {
  status?: number
  body?: unknown
  headers?: Record<string, string>
}

/** Build a `Response`-like object good enough for the SDK's transport. */
export function makeResponse(spec: MockResponseSpec = {}): Response {
  const status = spec.status ?? 200
  const text = spec.body === undefined ? '' : JSON.stringify(spec.body)
  const headers = new Headers(spec.headers ?? {})
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers,
    text: () => Promise.resolve(text),
  } as unknown as Response
}

/**
 * A mock fetch that returns queued responses in order and records every call.
 * Each entry may be a spec or a function that receives (url, init).
 */
export function mockFetch(
  responses: Array<MockResponseSpec | ((url: string, init?: RequestInit) => MockResponseSpec)>
): {
  fetch: FetchLike
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  let i = 0
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    const entry = responses[Math.min(i, responses.length - 1)]
    i += 1
    const spec = typeof entry === 'function' ? entry(url, init) : (entry ?? {})
    return makeResponse(spec)
  }) as unknown as FetchLike
  return { fetch, calls }
}

/** A mock fetch that rejects (simulates a transport/network failure). */
export function rejectingFetch(error: Error): FetchLike {
  return vi.fn(async () => {
    throw error
  }) as unknown as FetchLike
}
