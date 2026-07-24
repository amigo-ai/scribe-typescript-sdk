import { describe, expect, it } from 'vitest'
import { STT_SAMPLE_RATE, floatToPcm16 } from '../src/audio'

/** Read a PCM16 ArrayBuffer back as signed 16-bit samples. */
function samples(buffer: ArrayBuffer): number[] {
  return Array.from(new Int16Array(buffer))
}

describe('audio', () => {
  it('exposes the 16 kHz STT sample rate', () => {
    expect(STT_SAMPLE_RATE).toBe(16000)
  })

  it('preserves length and produces a 2-byte-per-sample buffer', () => {
    const out = floatToPcm16(new Float32Array([0, 0, 0]))
    expect(out.byteLength).toBe(6)
    expect(samples(out)).toEqual([0, 0, 0])
  })

  it('scales full-scale samples to the Int16 extremes (asymmetric)', () => {
    expect(samples(floatToPcm16(new Float32Array([1, -1, 0.5, -0.5])))).toEqual([
      32767, // 1 * 0x7fff
      -32768, // -1 * 0x8000
      16383, // trunc(0.5 * 0x7fff) = trunc(16383.5)
      -16384, // -0.5 * 0x8000
    ])
  })

  it('clamps out-of-range samples to [-1, 1]', () => {
    expect(samples(floatToPcm16(new Float32Array([2, -2, 1.5, -3])))).toEqual([
      32767, -32768, 32767, -32768,
    ])
  })

  it('returns an empty buffer for empty input', () => {
    expect(floatToPcm16(new Float32Array([])).byteLength).toBe(0)
  })
})
