import { describe, expect, it } from 'vitest'
import { normalizeTurn } from '../src/normalize'

describe('normalizeTurn', () => {
  it('normalizes a transcript_segment as final', () => {
    expect(
      normalizeTurn({
        type: 'transcript_segment',
        ordinal: 3,
        speaker: 'Clinician',
        text: '  hello world  ',
        final: true,
        timestamp: 5,
      })
    ).toEqual({ ordinal: 3, speaker: 'Clinician', text: 'hello world', final: true, timestamp: 5 })
  })

  it('treats transcript_segment as final unless final === false', () => {
    expect(normalizeTurn({ type: 'transcript_segment', ordinal: 1, text: 'x' })?.final).toBe(true)
    expect(
      normalizeTurn({ type: 'transcript_segment', ordinal: 1, text: 'x', final: false })?.final
    ).toBe(false)
  })

  it('normalizes an interim_transcript as always partial', () => {
    const seg = normalizeTurn({
      type: 'interim_transcript',
      ordinal: 2,
      text: 'partial',
      final: true, // ignored for interim
    })
    expect(seg?.final).toBe(false)
  })

  it('defaults the speaker to "Speaker" and timestamp to null', () => {
    expect(normalizeTurn({ type: 'transcript_segment', ordinal: 0, text: 'x' })).toEqual({
      ordinal: 0,
      speaker: 'Speaker',
      text: 'x',
      final: true,
      timestamp: null,
    })
  })

  it('drops empty / whitespace-only text', () => {
    expect(normalizeTurn({ type: 'transcript_segment', ordinal: 1, text: '   ' })).toBeNull()
    expect(normalizeTurn({ type: 'transcript_segment', ordinal: 1 })).toBeNull()
  })

  it('drops frames without a numeric ordinal', () => {
    expect(normalizeTurn({ type: 'transcript_segment', text: 'x' })).toBeNull()
    expect(
      normalizeTurn({ type: 'transcript_segment', ordinal: '3' as unknown as number, text: 'x' })
    ).toBeNull()
  })

  it('returns null for non-transcript frames', () => {
    expect(normalizeTurn({ type: 'ack', audio_offset_bytes: 10 })).toBeNull()
    expect(normalizeTurn({ type: 'pong' })).toBeNull()
  })
})
