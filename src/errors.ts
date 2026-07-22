/**
 * Base error class for all Scribe SDK errors.
 */
export class ScribeError extends Error {
  /** HTTP status code, if the error originated from an HTTP response. */
  readonly statusCode?: number
  /** Machine-readable error code from the API response body, if present. */
  readonly errorCode?: string
  /** Additional context (parsed response body, request info, etc.). */
  context?: Record<string, unknown>

  constructor(message: string, options?: Record<string, unknown>) {
    super(message)
    this.name = this.constructor.name
    Object.setPrototypeOf(this, new.target.prototype)
    // captureStackTrace is a V8 extension (Chrome/Node), absent from the DOM
    // lib typings — reference it defensively so the browser-only build passes.
    const errorCtor = Error as unknown as {
      captureStackTrace?: (target: object, ctor?: unknown) => void
    }
    if (typeof errorCtor.captureStackTrace === 'function') {
      errorCtor.captureStackTrace(this, this.constructor)
    }
    Object.assign(this, options)
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      errorCode: this.errorCode,
      context: this.context,
    }
  }
}

/* 4xx client errors */
export class BadRequestError extends ScribeError {}
export class AuthenticationError extends ScribeError {}
export class PermissionError extends ScribeError {}
export class NotFoundError extends ScribeError {}
export class ConflictError extends ScribeError {}
export class ValidationError extends BadRequestError {}
export class RateLimitError extends ScribeError {}

/* 5xx server errors */
export class ServerError extends ScribeError {}

/**
 * 503 — the streaming Fleet has no capacity to allocate right now, or the
 * dispatcher is temporarily unavailable. Carries `retryAfterSeconds` parsed
 * from the `Retry-After` response header when present.
 */
export class ServiceUnavailableError extends ServerError {
  // `declare` so no runtime class field is emitted — the value is set by the
  // base constructor's Object.assign(this, options). A real field declaration
  // would re-initialize this to undefined after super() and clobber it.
  declare readonly retryAfterSeconds?: number
}

/* Internal SDK errors */
export class ConfigurationError extends ScribeError {
  constructor(
    message: string,
    public field?: string
  ) {
    super(message)
    this.context = { field }
  }
}

/* Network / transport errors (no HTTP response received) */
export class NetworkError extends ScribeError {
  constructor(
    message: string,
    public readonly originalError?: Error,
    public readonly request?: { url?: string; method?: string }
  ) {
    super(message, { cause: originalError })
    this.context = { request }
  }
}

export function isScribeError(error: unknown): error is ScribeError {
  return error instanceof ScribeError
}

const STATUS_ERROR_MAP: Record<number, typeof ScribeError> = {
  400: BadRequestError,
  401: AuthenticationError,
  403: PermissionError,
  404: NotFoundError,
  409: ConflictError,
  422: ValidationError,
  429: RateLimitError,
  500: ServerError,
  503: ServiceUnavailableError,
}

const MESSAGE_KEYS = ['detail', 'message', 'error']

/**
 * Build the appropriate {@link ScribeError} subclass from an HTTP response and
 * its (already-parsed) body.
 */
export function createApiError(response: Response, body?: unknown): ScribeError {
  const ErrorClass = STATUS_ERROR_MAP[response.status] ?? ScribeError

  let message = `HTTP ${response.status} ${response.statusText}`.trim()
  let errorCode: string | undefined
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>
    for (const key of MESSAGE_KEYS) {
      if (key in record && record[key]) {
        message = String(record[key])
        break
      }
    }
    if ('code' in record && record.code) {
      errorCode = String(record.code)
    }
  }

  const options: Record<string, unknown> = {
    statusCode: response.status,
    errorCode,
    context: { body },
  }

  if (ErrorClass === ServiceUnavailableError) {
    const header = response.headers.get('retry-after')
    if (header) {
      const seconds = Number(header)
      if (!Number.isNaN(seconds)) {
        options.retryAfterSeconds = seconds
      }
    }
  }

  return new ErrorClass(message, options)
}
