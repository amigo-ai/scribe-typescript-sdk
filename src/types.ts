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

import type { components, operations } from './generated/openapi'

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

/**
 * Query params for {@link ScribeClient.listSessions} — `limit` (page size) and
 * `continuation_token` (opaque cursor from a prior page's response). Both
 * optional; derived from the generated `list-sessions` operation. The
 * generated `continuation_token` is `unknown` (the spec gives it no type), so
 * it is narrowed to `string` here — the cursor is always the opaque string a
 * prior {@link SessionListResponse.continuation_token} handed back.
 */
export type ListSessionsParams = Omit<
  NonNullable<operations['list-sessions']['parameters']['query']>,
  'continuation_token'
> & { continuation_token?: string }

/**
 * Response from list-sessions (`SessionListResponse`).
 *
 * `items` is a page of {@link SessionResponse}; `has_more` signals whether
 * another page exists; `continuation_token` (when present) is the cursor to
 * pass back as {@link ListSessionsParams.continuation_token} for the next page.
 */
export type SessionListResponse = Schemas['SessionListResponse']

/** Metadata describing a single model generation (`GenerationMetadata`). */
export type GenerationMetadata = Schemas['GenerationMetadata']

/** A session's clinical note (`NoteResponse`). */
export type NoteResponse = Schemas['NoteResponse']

/** Request body for {@link ScribeClient.generateNote} (`GenerateNoteRequest`). All fields optional. */
export type GenerateNoteRequest = Schemas['GenerateNoteRequest']

/** Response from generate-note (`GeneratedNoteResponse`) — the note plus its generation metadata. */
export type GeneratedNoteResponse = Schemas['GeneratedNoteResponse']

/** Response from finalize-note (`FinalizeNoteResponse`) — the signed/finalized note. */
export type FinalizeNoteResponse = Schemas['FinalizeNoteResponse']

/** A session's summary (`SummaryResponse`). */
export type SummaryResponse = Schemas['SummaryResponse']

/** Response from generate-summary (`GeneratedSummaryResponse`) — the summary plus its generation metadata. */
export type GeneratedSummaryResponse = Schemas['GeneratedSummaryResponse']

/** A single checklist item (`ChecklistItemResponse`). */
export type ChecklistItemResponse = Schemas['ChecklistItemResponse']

/** A session's checklist (`ChecklistResponse`). */
export type ChecklistResponse = Schemas['ChecklistResponse']

/** Request body for {@link ScribeClient.generateChecklist} (`GenerateChecklistRequest`). `items` is required. */
export type GenerateChecklistRequest = Schemas['GenerateChecklistRequest']

/** Response from generate-checklist (`GeneratedChecklistResponse`) — the checklist plus its generation metadata. */
export type GeneratedChecklistResponse = Schemas['GeneratedChecklistResponse']

/** A single suggested code (`CodeSuggestionResponse`). */
export type CodeSuggestionResponse = Schemas['CodeSuggestionResponse']

/** Response from get-codes (`CodesResponse`) — the session's suggested billing/clinical codes. */
export type CodesResponse = Schemas['CodesResponse']
