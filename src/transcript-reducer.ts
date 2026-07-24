import type { SttTranscriptSegment } from './normalize'

/**
 * Immutable transcript state: segments ordered by server-owned `ordinal`.
 *
 * Naive segment-key dedup is impossible (the STT provider restarts turn order
 * per socket and re-transcribes to different text), so reconnect correctness
 * relies on the **server-owned ordinal** (MASTER decisions 6 / 6.i): the reducer
 * keys purely on `ordinal` and does no client re-basing — there is no
 * `finalCount`/`turnIdBase`.
 */
export interface TranscriptState {
  readonly segments: readonly SttTranscriptSegment[]
}

/** The empty transcript. */
export const initialTranscriptState: TranscriptState = { segments: [] }

/**
 * Fold one normalized segment into the transcript, keyed on `ordinal`:
 *
 * - **New ordinal** → inserted in ordinal order.
 * - **Existing ordinal** → overwritten in place (partial→final promotion, or a
 *   re-delivered final replacing an earlier one).
 * - **Late partial after a final** → ignored (a final never regresses to a
 *   partial at the same ordinal).
 *
 * Pure: returns a new state (or the same reference when nothing changes).
 */
export function transcriptReducer(
  state: TranscriptState,
  segment: SttTranscriptSegment
): TranscriptState {
  const { segments } = state
  const index = segments.findIndex(s => s.ordinal === segment.ordinal)

  if (index === -1) {
    // Insert in ascending ordinal order.
    let insertAt = segments.length
    for (let i = 0; i < segments.length; i++) {
      if (segments[i]!.ordinal > segment.ordinal) {
        insertAt = i
        break
      }
    }
    const next = segments.slice()
    next.splice(insertAt, 0, segment)
    return { segments: next }
  }

  const existing = segments[index]!
  // Final wins: a late partial never clobbers an existing final at this ordinal.
  if (existing.final && !segment.final) {
    return state
  }
  const next = segments.slice()
  next[index] = segment
  return { segments: next }
}

/** Reset to the empty transcript (e.g. a new session). */
export function resetTranscript(): TranscriptState {
  return initialTranscriptState
}
