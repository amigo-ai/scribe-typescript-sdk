import { ConfigurationError } from './errors'
import { HttpClient, type ScribeClientConfig as HttpConfig } from './http'
import type {
  AllocateResponse,
  CreateSessionRequest,
  SessionResponse,
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
 * Typed client for the Scribe CRUD REST endpoints:
 * create-session → allocate → get-transcript.
 *
 * The create/allocate writes require a bearer token carrying the
 * `scribe:sessions:write` scope; get-transcript requires
 * `scribe:sessions:read_own`. Both are provider-principal endpoints.
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
}
