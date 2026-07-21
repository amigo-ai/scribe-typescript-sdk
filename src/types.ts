/**
 * Wire types for the Scribe CRUD REST API.
 *
 * These mirror the scribe service's Pydantic models
 * (`platform/services/scribe/src/models.py`) 1:1, in snake_case, so the SDK
 * matches the API exactly with no lossy mapping layer.
 */

/** Lifecycle status of a scribe session. */
export type SessionStatus =
  'created' | 'in-progress' | 'in-review' | 'completed' | 'cancelled' | 'failed'

/** Availability of a per-session artifact. */
export type ArtifactAvailability = 'pending' | 'available' | 'failed'

export interface ArtifactAvailabilityResponse {
  transcript: ArtifactAvailability
  note: ArtifactAvailability
  summary: ArtifactAvailability
  codes: ArtifactAvailability
}

/** Request body for {@link ScribeClient.createSession}. All fields optional. */
export interface CreateSessionRequest {
  /** Caller's external appointment identifier (max 512 chars). */
  external_appointment_id?: string
  /**
   * Caller's external session identifier (max 512 chars). Reusing an
   * `external_id` already owned by the same provider is idempotent; a
   * different provider in the same workspace gets a 409 ({@link ConflictError}).
   */
  external_id?: string
  /** Arbitrary metadata bag. Defaults to `{}` server-side. */
  metadata?: Record<string, unknown>
}

/** Response from create-session (`SessionResponse`). */
export interface SessionResponse {
  /** Session id (UUID). NOTE: the field is `id`, not `session_id`. */
  id: string
  status: SessionStatus
  external_appointment_id?: string | null
  /** ISO-8601 datetime, or null before the session starts. */
  started_at?: string | null
  /** ISO-8601 datetime, or null before the session ends. */
  ended_at?: string | null
  /** ISO-8601 datetime. */
  created_at: string
  /** ISO-8601 datetime. */
  updated_at: string
  artifacts: ArtifactAvailabilityResponse
}

/** Response from allocate (`AllocateResponse`). */
export interface AllocateResponse {
  /** `<gameserver_name>.<scribe_actors_domain>` — the WS host to attach to. */
  host: string
  /** ISO-8601 datetime when the allocation (and session) expires (~2h out). */
  expires_at: string
}

/** A single transcript segment (`TranscriptSegment`). */
export interface TranscriptSegment {
  speaker?: string | null
  text: string
  /** Segment start offset in milliseconds (integer, >= 0). */
  start_ms: number
  /** Segment end offset in milliseconds (integer, >= 0). */
  end_ms: number
}

/** Response from get-transcript (`TranscriptResponse`). */
export interface TranscriptResponse {
  /** Session id (UUID). NOTE: here the field IS `session_id`. */
  session_id: string
  segments: TranscriptSegment[]
}

/** Error body shape returned by the scribe service for non-2xx responses. */
export interface ErrorResponseBody {
  code: string
  message: string
  correlation_id: string
  details: Array<{ field: string | null; message: string }>
}
