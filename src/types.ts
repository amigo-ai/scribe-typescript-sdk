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

/** Modality of a scribe session: an in-person ("mic") recording or a Zoom meeting. */
export type SessionMode = Schemas['SessionMode']

/** Availability of a per-session artifact. */
export type ArtifactAvailability = Schemas['ArtifactAvailability']

export type ArtifactAvailabilityResponse = Schemas['ArtifactAvailabilityResponse']

/**
 * Request body for {@link ScribeClient.createSession}. All fields optional.
 *
 * Reusing an `external_id` already owned by the same provider is idempotent; a
 * different provider in the same workspace gets a 409 ({@link ConflictError}).
 *
 * `mode` is narrowed to optional here: the generated schema marks it required
 * because it carries a server-side default (`in_person`), but callers may omit
 * it (the server applies the default). Pass `mode: 'zoom'` for a Zoom session.
 */
export type CreateSessionRequest = Omit<Schemas['CreateSessionRequest'], 'mode'> & {
  mode?: SessionMode
}

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
 * it is narrowed to `string | number | null` here — staging returns the cursor
 * as a number (and `null` when there is no next page), matching the narrowed
 * {@link SessionListResponse.continuation_token}. This lets a prior page's
 * `continuation_token` be threaded straight back in without a cast; the client
 * stringifies a real cursor into the query and skips a `null`/absent one.
 */
export type ListSessionsParams = Omit<
  NonNullable<operations['list-sessions']['parameters']['query']>,
  'continuation_token'
> & { continuation_token?: string | number | null }

/**
 * Response from list-sessions (`SessionListResponse`).
 *
 * `items` is a page of {@link SessionResponse}; `has_more` signals whether
 * another page exists; `continuation_token` is the cursor to pass back as
 * {@link ListSessionsParams.continuation_token} for the next page (a number on
 * staging), or `null` when there is no next page.
 *
 * The generated `continuation_token` is `unknown`; it is narrowed here to
 * `string | number | null` so a prior page's token threads back into
 * {@link ScribeClient.listSessions} without a cast.
 */
export type SessionListResponse = Omit<Schemas['SessionListResponse'], 'continuation_token'> & {
  continuation_token?: string | number | null
}

/**
 * Request body for {@link ScribeClient.updateSession} (`UpdateSessionRequest`).
 *
 * All fields optional; only fields present in the body are updated (the server
 * uses `exclude_unset`). `external_appointment_id` is explicitly nullable —
 * sending `null` clears the appointment link, while omitting it leaves the link
 * as-is.
 */
export type UpdateSessionRequest = Schemas['UpdateSessionRequest']

/**
 * The scribe session linked to an appointment (`AppointmentSession`) — the
 * most-recent non-cancelled match on `external_appointment_id`.
 *
 * A focused subset of {@link SessionResponse} (id + status + lifecycle
 * timestamps, minus the artifact-availability sub-object) so a client can render
 * the appointment's visit state without a second lookup. `null` when the
 * appointment has no linked session yet.
 */
export type AppointmentSession = Schemas['AppointmentSession']

/**
 * A single appointment (`AppointmentResponse`), carrying its nested
 * {@link AppointmentSession} (or `null` when unlinked).
 */
export type AppointmentResponse = Schemas['AppointmentResponse']

/**
 * Query params for {@link ScribeClient.listAppointments} — `limit` (page size)
 * and `continuation_token` (opaque cursor from a prior page's response). Both
 * optional. Mirrors {@link ListSessionsParams}: the generated
 * `continuation_token` is `unknown` (the spec gives it no type), so it is
 * narrowed to `string | number | null` here, letting a prior page's token thread
 * straight back in without a cast.
 */
export type ListAppointmentsParams = Omit<
  NonNullable<operations['list-appointments']['parameters']['query']>,
  'continuation_token'
> & { continuation_token?: string | number | null }

/**
 * Response from list-appointments (`AppointmentListResponse`).
 *
 * `items` is a page of {@link AppointmentResponse}; `has_more` signals whether
 * another page exists; `continuation_token` is the cursor to pass back as
 * {@link ListAppointmentsParams.continuation_token} for the next page, or `null`
 * when there is no next page. Mirrors {@link SessionListResponse}: the generated
 * `continuation_token` is `unknown` and narrowed here to `string | number | null`.
 */
export type AppointmentListResponse = Omit<
  Schemas['AppointmentListResponse'],
  'continuation_token'
> & {
  continuation_token?: string | number | null
}

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

/** Response from generate-codes (`GeneratedCodesResponse`) — the codes plus their generation metadata. */
export type GeneratedCodesResponse = Schemas['GeneratedCodesResponse']

// ---------------------------------------------------------------------------
// Phase 02–08 additions (GA 0.4.0). Aliases of the generated schemas for the
// attach-ticket, Zoom saga/controls/events/OAuth, versioned note write /
// finalize, code decisions, and checklist toggle endpoints — plus the
// reload-safe `*ReadResponse` artifact-poller shapes (carry `generation_status`
// and, for the note, `version`) and the async-generation `202` envelope.
// ---------------------------------------------------------------------------

/* --- Async generation (phase 07) --- */

/** Terminal-or-pending status of a single generation job (`pending`/`succeeded`/`failed`). */
export type GenerationStatus = Schemas['GenerationStatus']

/** Read-time generation status of an artifact (`ready`/`pending`/`failed`). */
export type GenerationReadStatus = Schemas['GenerationReadStatus']

/** Which artifact a generation job produces (`ArtifactKind`). */
export type ArtifactKind = Schemas['ArtifactKind']

/** Handle to an enqueued (or collapsed-onto-in-flight) generation job (`GenerationEnvelope`). */
export type GenerationEnvelope = Schemas['GenerationEnvelope']

/**
 * `202` body from a `generate*` call: the async job was enqueued (or collapsed
 * onto an in-flight one) rather than produced synchronously. Carries the
 * {@link GenerationEnvelope} to poll the corresponding `get*` read shape.
 */
export type GenerationEnqueueResponse = Schemas['GenerationEnqueueResponse']

/** Structured error detail (`ErrorDetail`) attached to a read-shape's `error`. */
export type ErrorDetail = Schemas['ErrorDetail']

/**
 * Union return of `generate*` (phase 07): the service either produces the
 * artifact synchronously (`200`, `Generated*Response`) or enqueues an async job
 * (`202`, {@link GenerationEnqueueResponse}). Discriminate with
 * {@link isGenerationEnqueued}.
 */
export type NoteGenerationResult = GeneratedNoteResponse | GenerationEnqueueResponse
export type SummaryGenerationResult = GeneratedSummaryResponse | GenerationEnqueueResponse
export type ChecklistGenerationResult = GeneratedChecklistResponse | GenerationEnqueueResponse
export type CodesGenerationResult = GeneratedCodesResponse | GenerationEnqueueResponse

/**
 * Narrow a `generate*` result to the async-enqueue (`202`) branch. When `true`,
 * `result.generation` is the {@link GenerationEnvelope}; otherwise the artifact
 * was produced synchronously.
 */
export function isGenerationEnqueued(
  result: GenerationEnqueueResponse | { generation?: unknown } | Record<string, unknown>
): result is GenerationEnqueueResponse {
  const gen = (result as { generation?: unknown }).generation
  return (
    typeof gen === 'object' &&
    gen !== null &&
    'status' in (gen as Record<string, unknown>) &&
    'artifact_kind' in (gen as Record<string, unknown>)
  )
}

/* --- Reload-safe artifact read shapes (phases 07/08) --- */

/**
 * Reload-safe note poller (`NoteReadResponse`). Artifact fields (`body`,
 * `structured`, `version`, …) are present only when
 * `generation_status === 'ready'`; while `pending` the poller returns the status
 * with null artifact fields, and `failed` carries an {@link ErrorDetail}. Note
 * the persisted `version` (used as the `base_version` for
 * {@link ScribeClient.putNote} / {@link ScribeClient.finalizeNote}).
 */
export type NoteReadResponse = Schemas['NoteReadResponse']

/** Reload-safe summary poller (`SummaryReadResponse`) — carries `generation_status`. */
export type SummaryReadResponse = Schemas['SummaryReadResponse']

/** Reload-safe checklist poller (`ChecklistReadResponse`) — carries `generation_status`. */
export type ChecklistReadResponse = Schemas['ChecklistReadResponse']

/** Reload-safe codes poller (`CodesReadResponse`) — carries `generation_status`. */
export type CodesReadResponse = Schemas['CodesReadResponse']

/** A checklist item with manual-state + provenance overlaid (`ChecklistItemStateResponse`). */
export type ChecklistItemStateResponse = Schemas['ChecklistItemStateResponse']

/* --- Attach ticket (phase 02) --- */

/**
 * Response from {@link ScribeClient.mintTicket} (`TicketResponse`) — a WS-only,
 * session-bound attach ticket (`aud=scribe-streaming`, ~5-min TTL) and its
 * `expires_at`. This is the only credential that ever reaches the browser.
 */
export type TicketResponse = Schemas['TicketResponse']

/* --- Versioned note write / finalize (phase 08) --- */

/**
 * Request body for {@link ScribeClient.putNote} (`UpdateNoteRequest`) — a
 * versioned autosave. Provide exactly one of `body` / `structured` per write and
 * the `base_version` the client last read; a stale `base_version` loses the
 * compare-and-set and returns `409 version_conflict`.
 */
export type UpdateNoteRequest = Schemas['UpdateNoteRequest']

/** Response from {@link ScribeClient.putNote} (`UpdateNoteResponse`) — the new `version` + `updated_at`. */
export type UpdateNoteResponse = Schemas['UpdateNoteResponse']

/**
 * Request body for {@link ScribeClient.finalizeNote} (`FinalizeNoteRequest`) —
 * the `base_version` being finalized; a stale value returns `409
 * version_conflict`.
 */
export type FinalizeNoteRequest = Schemas['FinalizeNoteRequest']

/* --- Code decisions (phase 08) --- */

/** Request body for {@link ScribeClient.patchCode} (`CodeDecisionRequest`) — `approved` / `rejected`. */
export type CodeDecisionRequest = Schemas['CodeDecisionRequest']

/** Response from {@link ScribeClient.patchCode} (`CodeDecisionResponse`) — the persisted decision. */
export type CodeDecisionResponse = Schemas['CodeDecisionResponse']

/* --- Checklist toggles (phase 08) --- */

/** A single manual checklist toggle (`ChecklistItemToggle`). */
export type ChecklistItemToggle = Schemas['ChecklistItemToggle']

/** Request body for {@link ScribeClient.patchChecklist} (`UpdateChecklistRequest`) — `items` (manual toggles). */
export type UpdateChecklistRequest = Schemas['UpdateChecklistRequest']

/** Response from {@link ScribeClient.patchChecklist} (`ChecklistStateResponse`) — the checklist with per-item state + provenance. */
export type ChecklistStateResponse = Schemas['ChecklistStateResponse']

/* --- Zoom saga / controls / OAuth (phases 04/05) --- */

/** Disclosure config for a Zoom capture bot (`ZoomDisclosureRequest`). */
export type ZoomDisclosureRequest = Schemas['ZoomDisclosureRequest']

/** Request body for {@link ScribeClient.createZoomSession} (`ZoomSessionRequest`). */
export type ZoomSessionRequest = Schemas['ZoomSessionRequest']

/** Response from {@link ScribeClient.createZoomSession} (`ZoomSessionResponse`) — the created session + dispatched `bot_id`. */
export type ZoomSessionResponse = Schemas['ZoomSessionResponse']

/** Response from {@link ScribeClient.pauseZoom} / {@link ScribeClient.resumeZoom} (`ZoomBotControlResponse`) — the bot's `bot_status`. */
export type ZoomBotControlResponse = Schemas['ZoomBotControlResponse']

/** Response from {@link ScribeClient.endZoom} (`ZoomSessionEndResponse`) — acknowledges the drain (`status: 'draining'`). */
export type ZoomSessionEndResponse = Schemas['ZoomSessionEndResponse']

/** Response from {@link ScribeClient.getZoomConnection} (`ZoomConnectionResponse`) — connection status only; never token material. */
export type ZoomConnectionResponse = Schemas['ZoomConnectionResponse']

/** Response from {@link ScribeClient.authorizeZoomOAuth} (`ZoomAuthorizeResponse`) — the `authorize_url` to navigate to. */
export type ZoomAuthorizeResponse = Schemas['ZoomAuthorizeResponse']

/* --- Zoom event stream (phase 06) --- */

/** One frame on the `GET /sessions/{id}/events` SSE stream (`ZoomSessionEvent`). */
export type ZoomSessionEvent = Schemas['ZoomSessionEvent']

/** The `event` discriminator of a {@link ZoomSessionEvent}. */
export type ZoomSessionEventType = ZoomSessionEvent['event']

/** `bot_status` SSE frame payload (`BotStatusEvent`) — the capture bot's lifecycle state. */
export type BotStatusEvent = Schemas['BotStatusEvent']

/** `transcript_segment` / `interim_transcript` SSE frame payload (`TranscriptSegmentEvent`). */
export type TranscriptSegmentEvent = Schemas['TranscriptSegmentEvent']

/** `transcript_finalized` SSE frame payload (`TranscriptFinalizedEvent`) — emitted once, empty body. */
export type TranscriptFinalizedEvent = Schemas['TranscriptFinalizedEvent']
