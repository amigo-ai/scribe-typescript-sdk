import { describe, expect, it } from 'vitest'
import type { SttTranscriptSegment } from '../src/normalize'
import {
  initialTranscriptState,
  resetTranscript,
  transcriptReducer,
} from '../src/transcript-reducer'

function seg(ordinal: number, text: string, final: boolean): SttTranscriptSegment {
  return { ordinal, speaker: 'Speaker', text, final, timestamp: null }
}

describe('transcriptReducer', () => {
  it('appends new ordinals', () => {
    let state = initialTranscriptState
    state = transcriptReducer(state, seg(0, 'a', false))
    state = transcriptReducer(state, seg(1, 'b', false))
    expect(state.segments.map(s => s.ordinal)).toEqual([0, 1])
  })

  it('inserts out-of-order ordinals in ascending order', () => {
    let state = initialTranscriptState
    state = transcriptReducer(state, seg(2, 'c', true))
    state = transcriptReducer(state, seg(0, 'a', true))
    state = transcriptReducer(state, seg(1, 'b', true))
    expect(state.segments.map(s => s.ordinal)).toEqual([0, 1, 2])
    expect(state.segments.map(s => s.text)).toEqual(['a', 'b', 'c'])
  })

  it('promotes a partial to a final at the same ordinal (overwrite-by-ordinal)', () => {
    let state = transcriptReducer(initialTranscriptState, seg(0, 'hel', false))
    state = transcriptReducer(state, seg(0, 'hello', true))
    expect(state.segments).toHaveLength(1)
    expect(state.segments[0]).toMatchObject({ ordinal: 0, text: 'hello', final: true })
  })

  it('overwrites a partial with a newer partial at the same ordinal', () => {
    let state = transcriptReducer(initialTranscriptState, seg(0, 'he', false))
    state = transcriptReducer(state, seg(0, 'hell', false))
    expect(state.segments).toHaveLength(1)
    expect(state.segments[0]).toMatchObject({ text: 'hell', final: false })
  })

  it('re-delivered final overwrites an earlier final at the same ordinal', () => {
    let state = transcriptReducer(initialTranscriptState, seg(0, 'first', true))
    state = transcriptReducer(state, seg(0, 'corrected', true))
    expect(state.segments).toHaveLength(1)
    expect(state.segments[0]).toMatchObject({ text: 'corrected', final: true })
  })

  it('ignores a late partial arriving after a final at the same ordinal (final wins)', () => {
    const finalState = transcriptReducer(initialTranscriptState, seg(0, 'done', true))
    const after = transcriptReducer(finalState, seg(0, 'do', false))
    expect(after).toBe(finalState) // same reference — no change
    expect(after.segments[0]).toMatchObject({ text: 'done', final: true })
  })

  it('resetTranscript returns the empty state', () => {
    expect(resetTranscript().segments).toEqual([])
  })
})
