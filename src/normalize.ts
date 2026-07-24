import { SERVER_MESSAGE } from './wire'
import type { RawServerFrame } from './wire'

/**
 * A provider-agnostic transcript segment, as delivered by the worker and
 * surfaced to the SDK consumer. Ordinals are **server-owned** (MASTER decision
 * 6.i): the client renders by the server's `ordinal` and does no re-basing.
 */
export interface SttTranscriptSegment {
  /** Server-owned ordinal — the stable key for this segment. */
  ordinal: number
  /** Speaker label (defaults to `"Speaker"` when the worker omits it). */
  speaker: string
  /** Segment text (trimmed). */
  text: string
  /** Whether this is a final segment (`interim_transcript` is always partial). */
  final: boolean
  /** Elapsed audio seconds when the worker provides it, else `null`. */
  timestamp: number | null
}

/**
 * Normalize a raw `transcript_segment` / `interim_transcript` worker frame into
 * a public {@link SttTranscriptSegment}.
 *
 * Returns `null` (segment to be dropped) when the frame is not a transcript
 * frame, has empty/whitespace-only text, or lacks a numeric ordinal.
 * `interim_transcript` frames are always `final: false`; `transcript_segment`
 * frames are `final` unless explicitly `final === false`.
 */
export function normalizeTurn(frame: RawServerFrame): SttTranscriptSegment | null {
  if (
    frame.type !== SERVER_MESSAGE.transcriptSegment &&
    frame.type !== SERVER_MESSAGE.interimTranscript
  ) {
    return null
  }
  const text = typeof frame.text === 'string' ? frame.text.trim() : ''
  if (!text) {
    return null
  }
  if (typeof frame.ordinal !== 'number') {
    return null
  }
  const final = frame.type === SERVER_MESSAGE.transcriptSegment ? frame.final !== false : false
  return {
    ordinal: frame.ordinal,
    speaker: typeof frame.speaker === 'string' && frame.speaker ? frame.speaker : 'Speaker',
    text,
    final,
    timestamp: typeof frame.timestamp === 'number' ? frame.timestamp : null,
  }
}
