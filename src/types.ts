/**
 * Wire types for the Scribe CRUD REST API.
 *
 * These are derived directly from the Scribe service's **production OpenAPI
 * document** (`https://scribe.platform.amigo.ai/v1/openapi.json`, vendored at
 * `openapi/scribe.json`) via `openapi-typescript` — see
 * `src/generated/openapi.ts` and `npm run generate:schema`. Aliasing the
 * generated `components["schemas"]` entries here keeps a single source of truth
 * (the API's own schema) with no hand-maintained duplicate, while preserving
 * the flat, ergonomic public type names the SDK exposes.
 */

import type { components } from './generated/openapi'

type Schemas = components['schemas']

/** Lifecycle status of a scribe session. */
export type SessionStatus = Schemas['SessionStatus']

/** Availability of a per-session artifact. */
export type ArtifactAvailability = Schemas['ArtifactAvailability']

export type ArtifactAvailabilityResponse = Schemas['ArtifactAvailabilityResponse']

/**
 * Request body for {@link ScribeClient.createSession}. All fields optional.
 *
 * Reusing an `external_id` already owned by the same provider is idempotent; a
 * different provider in the same workspace gets a 409 ({@link ConflictError}).
 */
export type CreateSessionRequest = Schemas['CreateSessionRequest']

/**
 * Response from create-session (`SessionResponse`).
 *
 * NOTE: the session identifier field is `id`, not `session_id`.
 */
export type SessionResponse = Schemas['SessionResponse']

/**
 * Response from allocate (`AllocateResponse`).
 *
 * `host` is the WS host to attach to (`<gameserver_name>.<scribe_actors_domain>`);
 * `expires_at` is an ISO-8601 datetime when the allocation (and session)
 * expires (~2h out).
 */
export type AllocateResponse = Schemas['AllocateResponse']

/** A single transcript segment (`TranscriptSegment`). */
export type TranscriptSegment = Schemas['TranscriptSegment']

/**
 * Response from get-transcript (`TranscriptResponse`).
 *
 * NOTE: here the session identifier field IS `session_id` (not `id`).
 */
export type TranscriptResponse = Schemas['TranscriptResponse']

/** Error body shape returned by the scribe service for non-2xx responses. */
export type ErrorResponseBody = Schemas['ErrorResponse']
