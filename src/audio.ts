// Audio-format helpers for the browser recording layer. Pure and
// side-effect-free — no DOM, no WebSocket, no React. Ported verbatim from the
// hand-rolled recorder proven in superscribe-web.

/** Sample rate (Hz) the Scribe STT worker expects on the wire. */
export const STT_SAMPLE_RATE = 16000

/**
 * Convert a `Float32Array` (Web Audio mono, samples in `[-1, 1]`) to a 16-bit
 * little-endian PCM `ArrayBuffer` — the byte format the streaming worker
 * consumes. Samples are clamped to `[-1, 1]`, then scaled asymmetrically
 * (`0x8000` for negatives, `0x7fff` for positives) so the full Int16 range is
 * used without overflow.
 */
export function floatToPcm16(input: Float32Array): ArrayBuffer {
  const output = new Int16Array(input.length)
  for (let index = 0; index < input.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, input[index]!))
    output[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff
  }
  return output.buffer
}
