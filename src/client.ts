import { ConfigurationError } from './errors'
import { HttpClient, type ScribeClientConfig as HttpConfig } from './http'
import type {
  AllocateResponse,
  ChecklistResponse,
  CodesResponse,
  CreateSessionRequest,
  FinalizeNoteResponse,
  GenerateChecklistRequest,
  GeneratedChecklistResponse,
  GeneratedNoteResponse,
  GeneratedSummaryResponse,
  GenerateNoteRequest,
  ListSessionsParams,
  NoteResponse,
  SessionListResponse,
  SessionResponse,
  SummaryResponse,
  TranscriptResponse,
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

  constructor(config: ScribeClientConfig) {
    if (!config?.workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    this.http = new HttpClient(config)
    this.defaultWorkspaceId = config.workspaceId
  }

  private resolveWorkspaceId(options?: CallOptions): string {
    const workspaceId = options?.workspaceId ?? this.defaultWorkspaceId
    if (!workspaceId) {
      throw new ConfigurationError('workspaceId is required', 'workspaceId')
    }
    return encodeURIComponent(workspaceId)
  }

  /**
   * Create a new scribe session.
   *
   * `POST /v1/{workspace_id}/sessions` → 201. Requires `scribe:sessions:write`.
   * Reusing an `external_id` you already own returns the existing session
   * (idempotent); a different provider's `external_id` yields a 409.
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
    })
  }

  /**
   * Fetch the persisted clinical note for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/note` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no note has been generated yet.
   */
  async getNote(sessionId: string, options?: CallOptions): Promise<NoteResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<NoteResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note`,
      signal: options?.signal,
    })
  }

  /**
   * Generate (or regenerate) the clinical note for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/note` → 200. Requires
   * `scribe:sessions:write`. Pass a `note_type` (and optional free-form
   * `instructions`) to steer generation. Returns the note plus its generation
   * metadata.
   */
  async generateNote(
    sessionId: string,
    input: GenerateNoteRequest,
    options?: CallOptions
  ): Promise<GeneratedNoteResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<GeneratedNoteResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note`,
      body: input,
      signal: options?.signal,
    })
  }

  /**
   * Finalize (sign) the session's note, freezing it from further regeneration.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/note/finalize` → 200.
   * Requires `scribe:sessions:write`. Takes no request body. 404 if no note
   * exists to finalize.
   */
  async finalizeNote(sessionId: string, options?: CallOptions): Promise<FinalizeNoteResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<FinalizeNoteResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/note/finalize`,
      signal: options?.signal,
    })
  }

  /**
   * Fetch the persisted summary for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/summary` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no summary has been generated yet.
   */
  async getSummary(sessionId: string, options?: CallOptions): Promise<SummaryResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<SummaryResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/summary`,
      signal: options?.signal,
    })
  }

  /**
   * Generate (or regenerate) the summary for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/summary` → 200. Requires
   * `scribe:sessions:write`. Takes no request body. Returns the summary plus
   * its generation metadata.
   */
  async generateSummary(
    sessionId: string,
    options?: CallOptions
  ): Promise<GeneratedSummaryResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<GeneratedSummaryResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/summary`,
      signal: options?.signal,
    })
  }

  /**
   * Fetch the persisted checklist for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/checklist` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no checklist has been generated yet.
   */
  async getChecklist(sessionId: string, options?: CallOptions): Promise<ChecklistResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<ChecklistResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist`,
      signal: options?.signal,
    })
  }

  /**
   * Generate the checklist for a session.
   *
   * `POST /v1/{workspace_id}/sessions/{session_id}/checklist` → 200. Requires
   * `scribe:sessions:write`. The request body's `items` are required (an
   * optional `title` may be supplied). Returns the checklist plus its
   * generation metadata.
   */
  async generateChecklist(
    sessionId: string,
    input: GenerateChecklistRequest,
    options?: CallOptions
  ): Promise<GeneratedChecklistResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<GeneratedChecklistResponse>({
      method: 'POST',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/checklist`,
      body: input,
      signal: options?.signal,
    })
  }

  /**
   * Fetch the suggested codes (billing / clinical) for a session.
   *
   * `GET /v1/{workspace_id}/sessions/{session_id}/codes` → 200. Requires
   * `scribe:sessions:read_own`. 404 while no codes have been generated yet.
   */
  async getCodes(sessionId: string, options?: CallOptions): Promise<CodesResponse> {
    const workspaceId = this.resolveWorkspaceId(options)
    if (!sessionId) {
      throw new ConfigurationError('sessionId is required', 'sessionId')
    }
    return this.http.request<CodesResponse>({
      method: 'GET',
      path: `/v1/${workspaceId}/sessions/${encodeURIComponent(sessionId)}/codes`,
      signal: options?.signal,
    })
  }
}
