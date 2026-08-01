import { type AskSessionOptions, type AskStreamFrame, askSession } from './ask-stream'
import { ConfigurationError } from './errors'
import { streamSessionEvents } from './event-stream'
import {
  HttpClient,
  type FetchLike,
  type ScribeClientConfig as HttpConfig,
  type TokenProvider,
} from './http'
import type { ZoomSessionEvent } from './types'
import type {
  ActionsGenerationResult,
  ActionsReadResponse,
  AllocateResponse,
  AppointmentListResponse,
  AppointmentResponse,
  AskHistoryMessage,
  AutoCheckResponse,
  ChecklistGenerationResult,
  ChecklistReadResponse,
  ChecklistStateResponse,
  CodeDecisionRequest,
  CodeDecisionResponse,
  CodesGenerationResult,
  CodesReadResponse,
  CreateSessionRequest,
  FinalizeNoteRequest,
  FinalizeNoteResponse,
  GenerateChecklistRequest,
  GenerateNoteRequest,
  GenerationEnqueueResponse,
  ListAppointmentsParams,
  ListSessionsParams,
  NoteGenerationResult,
  NoteReadResponse,
  RegenerateSectionRequest,
  SessionListResponse,
  SessionResponse,
  SummaryGenerationResult,
  SummaryReadResponse,
  TicketResponse,
  TranscriptResponse,
  UpdateChecklistRequest,
  UpdateNoteRequest,
  UpdateNoteResponse,
  UpdateSessionRequest,
  ZoomAuthorizeResponse,
  ZoomBotControlResponse,
  ZoomConnectionResponse,
  ZoomSessionEndResponse,
  ZoomSessionRequest,
  ZoomSessionResponse,
} from './types'

export interface ScribeClientConfig extends HttpConfig {
  /**
   * Workspace id this client is scoped to. Every CRUD path is
   * `/v1/{workspace_id}/...`, and the auth token's `workspace_id` claim must
   * match. Individual calls may override it.
   */
  workspaceId: string
}

/** Per-call options common to the CRUD methods. */
export interface CallOptions {
  /** Override the client's default workspace id for this call. */
  workspaceId?: string
  /** Abort signal for cancellation / timeouts. */
  signal?: AbortSignal
  /**
   * Per-call deadline in ms. When it elapses the request aborts and a
   * {@link TimeoutError} is thrown. Composes with `signal` (whichever fires
   * first wins). Equivalent to passing `signal: AbortSignal.timeout(ms)`.
   */
  timeoutMs?: number
}

/**
 * Typed client for the Scribe CRUD REST endpoints: session lifecycle
 * (create → allocate → list/get), transcript, and the per-session artifacts
 * (note, summary, checklist, codes) with their generate/finalize operations.
 *
 * Writes (create, allocate, generate*, finalize*) require a bearer token
 * carrying the `scribe:sessions:write` scope; reads (list, get*, getTranscript)
 * require `scribe:sessions:read_own`. All are provider-principal endpoints.
 */
export class ScribeClient {
  private readonly http: HttpClient
  private readonly defaultWorkspaceId: string
  // Retained for the SSE event-stream helper, which reads `fetch`'s
  // `ReadableStream` body directly rather than going through {@link HttpClient}.
  private readonly baseUrl: string
  private readonly token: TokenProvider
  private readonly fetchImpl?: FetchLike
  private readonly defaultHeaders?: Record<string, string>

  constructor(config: ScribeClientConfig) {
    if (!config?.workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    this.http = new HttpClient(config)
    this.defaultWorkspaceId = config.workspaceId
    this.baseUrl = config.baseUrl
    this.token = config.token
    this.fetchImpl = config.fetch
    this.defaultHeaders = config.defaultHeaders
  }

  private resolveWorkspaceId(options?: CallOptions): string {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    if (!workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    return encodeURIComponent(workspaceId)
  }

  /**
   * Create a new **in-person** scribe session.
   *
   * `POST /v1/{workspace_id}/sessions` → 201. Requires `scribe:sessions:write`.
   * Reusing an `external_id` you already own returns the existing session
   * (idempotent); a different provider's `external_id` yields a 409.
   *
   * This endpoint is in-person only. To create a **Zoom** session use
   * {@link ScribeClient.createZoomSession} (POST /zoom/sessions), which runs the
   * saga that dispatches the bot. A non-in-person `mode` is rejected server-side
   * with a {@link ValidationError} (422, `errorCode: 'use_zoom_endpoint'`); the
   * `mode` type is narrowed to `'in_person'` so this is also a compile-time error.
   */
  async createSession(
    input: CreateSessionRequest = {},
    options?: CallOptions
  ): Promise<SessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    return this.http.request<SessionResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Allocate a streaming GameServer for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/allocate` → 200. Requires
   * `scribe:sessions:write`. Returns `{ host, expires_at }` — `host` is the WS
   * host to attach to, `expires_at` an ISO-8601 datetime (~2h out).
   *
   * On capacity exhaustion / cooldown / allocator failure the service returns
   * 503, surfaced as {@link ServiceUnavailableError} with `retryAfterSeconds`
   * populated from the `Retry-After` header.
   */
  async allocate(sessionId: string, options?: CallOptions): Promise<AllocateResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<AllocateResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/allocate`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch a session's persisted transcript.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/transcript` → 200. Requires
   * `scribe:sessions:read_own`. 404 while the transcript is not yet available;
   * 503 if the artifact store is temporarily unreadable.
   */
  async getTranscript(sessionId: string, options?: CallOptions): Promise<TranscriptResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<TranscriptResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/transcript`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * List sessions in the workspace (newest first), cursor-paginated.
   *
   * `GET /v1/{workspace_id}/sessions` → 200. Requires `scribe:sessions:read_own`.
   * Pass `limit` to cap the page size and `continuation_token` (from a prior
   * response) to fetch the next page; `has_more` signals whether one exists.
   */
  async listSessions(
    params: ListSessionsParams = {},
    options?: CallOptions
  ): Promise<SessionListResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    const query: Record<string, string | number | boolean | undefined> = {}
    if (params.limit !== undefined) {
      query.limit = params.limit
    }
    // Skip a null/absent cursor (the server returns `null` on the last page) so
    // it is never serialized as the literal string "null"; a real cursor
    // (string or number) is stringified by the query builder.
    if (params.continuation_token != null) {
      query.continuation_token = params.continuation_token
    }
    return this.http.request<SessionListResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions`,
      query,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch a single session by id.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}` → 200. Requires
   * `scribe:sessions:read_own`. 404 if the session does not exist or is not
   * owned by the calling provider.
   */
  async getSession(sessionId: string, options?: CallOptions): Promise<SessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SessionResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Update mutable fields of a session.
   *
   * `PATCH /v1/{workspace_id}/sessions/{session_id}` → 200. Requires
   * `scribe:sessions:write` (owner-scoped). Only fields present in `patch` are
   * updated: `external_appointment_id` (nullable — pass `null` to clear the
   * appointment link), `metadata`, and `mode`. 404 if the session does not exist
   * or is not owned by the caller.
   */
  async updateSession(
    sessionId: string,
    patch: UpdateSessionRequest,
    options?: CallOptions
  ): Promise<SessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    // The request body is required (`UpdateSessionRequest`); an undefined `patch`
    // would omit the body entirely and `null` would serialize to the invalid
    // JSON literal `null`. Pass `{}` for a no-op patch (all fields optional).
    if (patch == null) {
      throw new ConfigurationError('patch is required', 'patch')
    }
    return this.http.request<SessionResponse>({
      method: 'PATCH',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}`,
      body: patch,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * End a session (guarded transition to `in-review`).
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/end` → 200. Requires
   * `scribe:sessions:write` (owner-scoped). Takes no request body. Returns the
   * updated session. While a live streaming attach exists the server rejects the
   * REST end with `409` ({@link ConflictError}, `session_streaming`) — send the
   * WS `end` control frame instead; the REST end never touches transcript
   * artifacts. 404 if the session does not exist or is not owned by the caller.
   */
  async endSession(sessionId: string, options?: CallOptions): Promise<SessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SessionResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/end`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Cancel a session (guarded transition to `cancelled`).
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/cancel` → 200. Requires
   * `scribe:sessions:write` (owner-scoped). Takes no request body. Returns the
   * updated session. 409 ({@link ConflictError}) when the session is already in a
   * terminal state that cannot transition to `cancelled`; 404 if it does not
   * exist or is not owned by the caller.
   */
  async cancelSession(sessionId: string, options?: CallOptions): Promise<SessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SessionResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/cancel`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Mint a session-bound, WS-only attach ticket for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/ticket` → 200. Requires
   * `scribe:sessions:write`. Returns a short-lived {@link TicketResponse}
   * (`aud=scribe-streaming`, ~5-min TTL) — the only credential that ever reaches
   * the browser. Hand it to {@link ScribeStreamClient} to attach the WS. 404 if
   * the session does not exist or is not owned by the caller.
   */
  async mintTicket(sessionId: string, options?: CallOptions): Promise<TicketResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<TicketResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/ticket`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Create a Zoom capture session — the whole server-side saga behind one call.
   *
   * `POST /v1/{workspace_id}/zoom/sessions` → 201. Requires
   * `scribe:sessions:write`. The browser hands only a `meeting_link` + a
   * `disclosure` choice (never a Zoom token): the API creates the session,
   * resolves the provider's STORED Zoom token, and dispatches the bot
   * server-side. Returns the created (`mode=zoom`, `in-progress`)
   * {@link ZoomSessionResponse} plus the dispatched `bot_id`. `409`
   * ({@link ConflictError}) when the provider is not connected to Zoom or the
   * `external_id` collides; `503` when the control plane is unavailable.
   *
   * The optional session-owned note-generation fields — `first_name`,
   * `last_name`, `visit_type` (a {@link VisitType}) and `note_template` (a
   * {@link NoteTemplate}) — feed downstream note generation + checklist seeding
   * server-side, mirroring {@link ScribeClient.createSession}. Omitting them is
   * backward-compatible; they can also be set later via
   * {@link ScribeClient.updateSession}.
   */
  async createZoomSession(
    input: ZoomSessionRequest,
    options?: CallOptions
  ): Promise<ZoomSessionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (input == null) {
      throw new ConfigurationError('input is required', 'input')
    }
    return this.http.request<ZoomSessionResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/zoom/sessions`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Pause the Zoom capture bot for a session (proxied control-plane command).
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/zoom/pause` → 200. Requires
   * `scribe:sessions:write`. Returns the {@link ZoomBotControlResponse} with the
   * bot's status after the command (the live transition also arrives over the
   * {@link ScribeClient.streamSessionEvents} stream). `502` if the control plane
   * rejects the command; `409` if the session is not a live Zoom session.
   */
  async pauseZoom(sessionId: string, options?: CallOptions): Promise<ZoomBotControlResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ZoomBotControlResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/zoom/pause`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Resume a paused Zoom capture bot for a session (proxied control-plane command).
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/zoom/resume` → 200. Requires
   * `scribe:sessions:write`. Mirror of {@link ScribeClient.pauseZoom}.
   */
  async resumeZoom(sessionId: string, options?: CallOptions): Promise<ZoomBotControlResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ZoomBotControlResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/zoom/resume`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * End a Zoom capture session — drain the bot and internally zoom-finalize.
   *
   * `DELETE /v1/{workspace_id}/sessions/{session_id}/zoom` → 202. Requires
   * `scribe:sessions:write`. Acknowledges that the drain + finalize is underway
   * ({@link ZoomSessionEndResponse} `status: 'draining'`); the session flips to
   * `in-review` asynchronously (reaper backstop). 404 if the session does not
   * exist or is not owned by the caller.
   */
  async endZoom(sessionId: string, options?: CallOptions): Promise<ZoomSessionEndResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ZoomSessionEndResponse>({
      method: 'DELETE',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/zoom`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch the provider's Zoom connection status for the workspace.
   *
   * `GET /v1/{workspace_id}/zoom/connection` → 200. Requires
   * `scribe:sessions:read_own`. Returns a {@link ZoomConnectionResponse} — a
   * boolean plus non-sensitive display fields (`connected_at`, `zoom_email`).
   * NEVER carries token material.
   */
  async getZoomConnection(options?: CallOptions): Promise<ZoomConnectionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    return this.http.request<ZoomConnectionResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/zoom/connection`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Disconnect the provider's stored Zoom connection (delete the custody record).
   *
   * `DELETE /v1/{workspace_id}/zoom/connection` → 204 (no body). Requires
   * `scribe:sessions:write`. Idempotent — a no-op when not connected.
   */
  async disconnectZoom(options?: CallOptions): Promise<void> {
    const workspaceId = this.resolveWorkspaceId(options)
    await this.http.request<void>({
      method: 'DELETE',
      path: `/v1/${workspaceId}/zoom/connection`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Start the Zoom OAuth authorization flow (server-held custody).
   *
   * `POST /v1/{workspace_id}/zoom/oauth/authorize` → 200. Requires
   * `scribe:sessions:write`. Returns a {@link ZoomAuthorizeResponse}: navigate
   * the top-level window to `authorize_url` (the in-memory Bearer header cannot
   * ride the redirect; the single-use server-held state embedded in the URL is
   * the credential the unauthenticated callback trusts). `expires_at` is when
   * that state's short TTL lapses. The callback (`GET /zoom/oauth/callback`) is a
   * server-side redirect endpoint, not an SDK method.
   */
  async authorizeZoomOAuth(options?: CallOptions): Promise<ZoomAuthorizeResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    return this.http.request<ZoomAuthorizeResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/zoom/oauth/authorize`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Stream a session's Zoom lifecycle + transcript events over SSE.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/events` — header-authenticated
   * `fetch` streaming (not `EventSource`, which cannot carry the Bearer header).
   * Returns an async generator of typed {@link ZoomSessionEvent} frames; consume
   * it with `for await`. Resumes from `Last-Event-ID` across reconnects, backs
   * off on transient drops, and stops after a terminal `bot_status`
   * (`done`/`error`) or when `options.signal` aborts.
   */
  streamSessionEvents(
    sessionId: string,
    options?: {
      workspaceId?: string
      signal?: AbortSignal
      lastEventId?: string
      maxRetries?: number
    }
  ): AsyncGenerator<ZoomSessionEvent, void, unknown> {
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    if (!workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    return streamSessionEvents({
      baseUrl: this.baseUrl,
      workspaceId,
      sessionId,
      token: this.token,
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.lastEventId !== undefined ? { lastEventId: options.lastEventId } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    })
  }

  /**
   * Fetch the persisted clinical note for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/note` → 200. Requires
   * `scribe:sessions:read_own`. Returns the reload-safe {@link NoteReadResponse}:
   * artifact fields (`body`/`structured`/`version`) are present only when
   * `generation_status === 'ready'`; while `pending` they are null. Read the
   * `version` to use as the `base_version` for {@link ScribeClient.putNote} /
   * {@link ScribeClient.finalizeNote}. 404 while no note exists at all.
   */
  async getNote(sessionId: string, options?: CallOptions): Promise<NoteReadResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<NoteReadResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Generate (or regenerate) the clinical note for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/note` → 200 (synchronous
   * artifact) or 202 (async job enqueued). Requires `scribe:sessions:write`.
   * Pass a `note_type` (and optional free-form `instructions`) to steer
   * generation. Returns {@link NoteGenerationResult} — narrow with
   * {@link isGenerationEnqueued} to poll {@link ScribeClient.getNote} for the
   * enqueued case.
   */
  async generateNote(
    sessionId: string,
    input: GenerateNoteRequest,
    options?: CallOptions
  ): Promise<NoteGenerationResult> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<NoteGenerationResult>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Versioned note autosave — persist an edited note body/structured document.
   *
   * `PUT /v1/{workspace_id}/sessions/{session_id}/note` → 200. Requires
   * `scribe:notes:rw_own`. Provide exactly one of `body` / `structured` and the
   * `base_version` you last read ({@link NoteReadResponse.version}). A stale
   * `base_version` loses the compare-and-set and returns `409` with
   * `errorCode === 'version_conflict'` ({@link ConflictError}); the returned
   * {@link UpdateNoteResponse} carries the new `version` (n+1). Once the note is
   * finalized, further writes return `409 invalid_session_state`.
   */
  async putNote(
    sessionId: string,
    input: UpdateNoteRequest,
    options?: CallOptions
  ): Promise<UpdateNoteResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<UpdateNoteResponse>({
      method: 'PUT',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Finalize (sign) the session's note, freezing it from further edits and
   * terminalizing the session to `completed`.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/note/finalize` → 200.
   * Requires `scribe:notes:rw_own`. The body's `base_version` is the version
   * being finalized; a stale value returns `409 version_conflict`
   * ({@link ConflictError}). 404 if no note exists to finalize; a subsequent
   * {@link ScribeClient.putNote} returns `409 invalid_session_state`.
   */
  async finalizeNote(
    sessionId: string,
    input: FinalizeNoteRequest,
    options?: CallOptions
  ): Promise<FinalizeNoteResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<FinalizeNoteResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note/finalize`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch the persisted summary for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/summary` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no summary has been generated yet.
   */
  async getSummary(sessionId: string, options?: CallOptions): Promise<SummaryReadResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SummaryReadResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/summary`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Generate (or regenerate) the summary for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/summary` → 200 (synchronous
   * artifact) or 202 (async job enqueued). Requires `scribe:sessions:write`.
   * Takes no request body. Returns {@link SummaryGenerationResult} — narrow with
   * {@link isGenerationEnqueued} to poll {@link ScribeClient.getSummary}.
   */
  async generateSummary(
    sessionId: string,
    options?: CallOptions
  ): Promise<SummaryGenerationResult> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SummaryGenerationResult>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/summary`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch the persisted checklist for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/checklist` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no checklist has been generated yet.
   */
  async getChecklist(sessionId: string, options?: CallOptions): Promise<ChecklistReadResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ChecklistReadResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Generate the checklist for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/checklist` → 200 (synchronous
   * artifact) or 202 (async job enqueued). Requires `scribe:sessions:write`. The
   * request body's `items` are required (an optional `title` may be supplied).
   * Returns {@link ChecklistGenerationResult} — narrow with
   * {@link isGenerationEnqueued} to poll {@link ScribeClient.getChecklist}.
   */
  async generateChecklist(
    sessionId: string,
    input: GenerateChecklistRequest,
    options?: CallOptions
  ): Promise<ChecklistGenerationResult> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ChecklistGenerationResult>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Apply manual per-item toggles to the session's checklist.
   *
   * `PATCH /v1/{workspace_id}/sessions/{session_id}/checklist` → 200. Requires
   * `scribe:notes:rw_own`. The body's `items` are the manual toggles (`id` +
   * `completed`); the response {@link ChecklistStateResponse} overlays per-item
   * manual state + provenance and recomputes the checklist `status`. `409`
   * ({@link ConflictError}) once the session is in a terminal state.
   */
  async patchChecklist(
    sessionId: string,
    input: UpdateChecklistRequest,
    options?: CallOptions
  ): Promise<ChecklistStateResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ChecklistStateResponse>({
      method: 'PATCH',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch the suggested codes (billing / clinical) for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/codes` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no codes have been generated yet.
   */
  async getCodes(sessionId: string, options?: CallOptions): Promise<CodesReadResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<CodesReadResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/codes`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Generate the suggested ICD codes for a session and persist them.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/codes` → 200 (synchronous
   * artifact) or 202 (async job enqueued). Requires `scribe:notes:rw_own`. Takes
   * no request body. Derives from the canonical transcript + latest note,
   * persists one `icd_suggestions` row per code. Returns
   * {@link CodesGenerationResult} — narrow with {@link isGenerationEnqueued} to
   * poll {@link ScribeClient.getCodes}.
   */
  async generateCodes(sessionId: string, options?: CallOptions): Promise<CodesGenerationResult> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<CodesGenerationResult>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/codes`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Record the provider's decision on a single suggested code.
   *
   * `PATCH /v1/{workspace_id}/sessions/{session_id}/codes/{suggestion_id}` → 200.
   * Requires `scribe:notes:rw_own`. The body's `decision` is `approved` /
   * `rejected`; idempotent and re-decidable until finalize. Returns the persisted
   * {@link CodeDecisionResponse}. 404 if the suggestion does not exist; `409`
   * ({@link ConflictError}) once the session is in a terminal state.
   */
  async patchCode(
    sessionId: string,
    suggestionId: string,
    input: CodeDecisionRequest,
    options?: CallOptions
  ): Promise<CodeDecisionResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    if (!suggestionId) {
      throw new ConfigurationError('suggestionId is required', 'suggestionId')
    }
    return this.http.request<CodeDecisionResponse>({
      method: 'PATCH',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/codes/${encodeURIComponent(suggestionId)}`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  // -------------------------------------------------------------------------
  // Phase 09 assist surface (0.5.0): actions artifact, section-scoped note
  // regeneration, checklist auto-check, and the `/ask` streaming Q&A helper.
  // -------------------------------------------------------------------------

  /**
   * Fetch the persisted follow-up `actions` for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/actions` → 200. Requires
   * `scribe:sessions:read_own`. Returns the reload-safe
   * {@link ActionsReadResponse}: `items` is present only when
   * `generation_status === 'ready'`; while `pending` it is null, and `failed`
   * carries an {@link ErrorDetail}. Poll this after an enqueued
   * {@link ScribeClient.generateActions}. 404 while no actions artifact exists.
   */
  async getActions(sessionId: string, options?: CallOptions): Promise<ActionsReadResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ActionsReadResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/actions`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Generate the follow-up `actions` for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/actions` → 200 (synchronous
   * artifact) or 202 (async job enqueued). Requires `scribe:sessions:write`.
   * Takes no request body. The actions job is also auto-enqueued when the note
   * job succeeds, and is idempotent by the same key. Returns
   * {@link ActionsGenerationResult} — narrow with {@link isGenerationEnqueued}
   * to poll {@link ScribeClient.getActions} for the enqueued case.
   */
  async generateActions(
    sessionId: string,
    options?: CallOptions
  ): Promise<ActionsGenerationResult> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ActionsGenerationResult>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/actions`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Regenerate a single named section of the current clinical note.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/note/regenerate-section` →
   * `202 {generation}`. Requires `scribe:notes:rw_own`. The body is
   * `{ section_id, instructions?, base_version }`: `base_version` is the note
   * version the client last read ({@link NoteReadResponse.version}); on success
   * the note `version` is bumped (poll {@link ScribeClient.getNote}). A stale
   * `base_version` loses the compare-and-set and returns `409` with
   * `errorCode === 'version_conflict'` ({@link ConflictError}); once the note is
   * finalized it returns `409 invalid_session_state`.
   */
  async regenerateSection(
    sessionId: string,
    input: RegenerateSectionRequest,
    options?: CallOptions
  ): Promise<GenerationEnqueueResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    if (input == null) {
      throw new ConfigurationError('input is required', 'input')
    }
    return this.http.request<GenerationEnqueueResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note/regenerate-section`,
      body: input,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Auto-check the session's checklist against the (partial) transcript.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/checklist/auto-check` → 200.
   * Requires `scribe:notes:rw_own`. Takes no request body. Returns
   * {@link AutoCheckResponse} — the LLM's per-item `matches`
   * (`{ item_id, matched, evidence? }`). Matched items are also persisted
   * server-side as `source='auto'` state, coexisting with (never clobbering) the
   * manual toggles from {@link ScribeClient.patchChecklist}. `409`
   * ({@link ConflictError}) once the session is in a terminal state.
   */
  async autoCheckChecklist(sessionId: string, options?: CallOptions): Promise<AutoCheckResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<AutoCheckResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist/auto-check`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Ask a question over a session's transcript + latest note (streaming Q&A).
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/ask` — header-authenticated
   * `fetch` streaming (not `EventSource`, which can neither send the Bearer
   * header nor POST a JSON body). Returns an async generator of
   * {@link AskStreamFrame}s: `delta {text}` chunks then a terminal
   * `done {generation_id}`; consume it with `for await` and read the
   * `generation_id` off the final frame. The answer is NOT persisted as an
   * artifact (only a provenance row). Aborts (and stops any pending retry) when
   * `options.signal` fires.
   */
  askSession(
    sessionId: string,
    input: { question: string; history?: AskHistoryMessage[] },
    options?: {
      workspaceId?: string
      signal?: AbortSignal
      maxRetries?: number
    }
  ): AsyncGenerator<AskStreamFrame, void, unknown> {
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    if (!input?.question) {
      throw new ConfigurationError('question is required', 'question')
    }
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    if (!workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    const askOptions: AskSessionOptions = {
      baseUrl: this.baseUrl,
      workspaceId,
      sessionId,
      token: this.token,
      question: input.question,
      ...(input.history ? { history: input.history } : {}),
      ...(this.fetchImpl ? { fetch: this.fetchImpl } : {}),
      ...(this.defaultHeaders ? { defaultHeaders: this.defaultHeaders } : {}),
      ...(options?.signal ? { signal: options.signal } : {}),
      ...(options?.maxRetries !== undefined ? { maxRetries: options.maxRetries } : {}),
    }
    return askSession(askOptions)
  }

  /**
   * List appointments in the workspace, cursor-paginated.
   *
   * `GET /v1/{workspace_id}/appointments` → 200. Requires
   * `scribe:sessions:read_own`. Each appointment carries a nested
   * {@link AppointmentSession} (the most-recent non-cancelled linked scribe
   * session, or `null`). Pass `limit` to cap the page size and
   * `continuation_token` (from a prior response) to fetch the next page;
   * `has_more` signals whether one exists.
   */
  async listAppointments(
    params: ListAppointmentsParams = {},
    options?: CallOptions
  ): Promise<AppointmentListResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    const query: Record<string, string | number | boolean | undefined> = {}
    if (params.limit !== undefined) {
      query.limit = params.limit
    }
    // Skip a null/absent cursor (the server returns `null` on the last page) so
    // it is never serialized as the literal string "null"; a real cursor
    // (string or number) is stringified by the query builder.
    if (params.continuation_token != null) {
      query.continuation_token = params.continuation_token
    }
    return this.http.request<AppointmentListResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/appointments`,
      query,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }

  /**
   * Fetch a single appointment by id.
   *
   * `GET /v1/{workspace_id}/appointments/{appointment_id}` → 200. Requires
   * `scribe:sessions:read_own`. The appointment carries its nested
   * {@link AppointmentSession} (or `null` when unlinked). 404 if the appointment
   * does not exist in the workspace.
   */
  async getAppointment(appointmentId: string, options?: CallOptions): Promise<AppointmentResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!appointmentId) {
      throw new ConfigurationError('appointmentId is required', 'appointmentId')
    }
    return this.http.request<AppointmentResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/appointments/${encodeURIComponent(appointmentId)}`,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    })
  }
}
