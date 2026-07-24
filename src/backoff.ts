/**
 * Reconnect backoff schedule.
 *
 * The ceiling MUST stay well below the worker's `reconnect_grace_seconds`
 * (default **300s**): once that grace window elapses the server tears the
 * session down and a reconnect would be rejected (`4009`). A single backoff
 * delay is capped at 20s and the attempt count is bounded so cumulative backoff
 * (~78s across 8 attempts) stays comfortably under the grace window.
 */
export const RECONNECT = {
  baseDelayMs: 1_000,
  factor: 2,
  maxDelayMs: 20_000,
  /** Max consecutive reconnect attempts before giving up (sum ≈ 78s ≪ 300s). */
  maxAttempts: 8,
} as const

/**
 * Exponential backoff delay (ms) for the Nth (0-based) reconnect attempt,
 * capped at {@link RECONNECT.maxDelayMs}. Pure, so callers/tests can assert the
 * schedule directly. No jitter — deterministic.
 */
export function backoffDelayMs(attempt: number): number {
  const raw = RECONNECT.baseDelayMs * RECONNECT.factor ** attempt
  return Math.min(raw, RECONNECT.maxDelayMs)
}
