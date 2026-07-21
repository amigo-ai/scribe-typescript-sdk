/**
 * @amigo-ai/scribe — framework-agnostic TypeScript SDK for the Amigo Scribe
 * streaming service.
 *
 * This first release ships the CRUD REST client (create-session, allocate,
 * get-transcript). The browser WebSocket recorder (`ScribeRecorder`) is a
 * later addition — see the scribe-streaming plan.
 */

export { ScribeClient } from './client'
export type { ScribeClientConfig, CallOptions } from './client'
export type { FetchLike, TokenProvider, RequestOptions } from './http'
export { HttpClient } from './http'
export * from './types'
export * from './errors'
