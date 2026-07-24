/**
 * Bounded audio ring buffer keyed by byte offset.
 *
 * Every PCM16 chunk sent to the worker is retained here with its starting byte
 * offset. The worker acks by cumulative byte offset (`{type:"ack",
 * audio_offset_bytes}`); on ack we drop every chunk fully covered by the ack,
 * so the buffer only ever holds *unacked* audio and is bounded by ack lag. On a
 * resumable reconnect we resend exactly the unacked chunks (MASTER decision 6:
 * only bytes past the acked offset are eligible for resend).
 */

interface Chunk {
  /** Byte offset of this chunk's first byte within the session's audio stream. */
  offset: number
  bytes: ArrayBuffer
}

export class AudioRingBuffer {
  private chunks: Chunk[] = []
  private sent = 0
  private acked = 0

  /** Total bytes ever appended (the offset the next chunk will start at). */
  get sentBytes(): number {
    return this.sent
  }

  /** Highest acked cumulative byte offset. */
  get ackedBytes(): number {
    return this.acked
  }

  /** Bytes retained (unacked) in the buffer. */
  get pendingBytes(): number {
    return this.chunks.reduce((total, chunk) => total + chunk.bytes.byteLength, 0)
  }

  /** Retain a chunk and advance the sent offset. Empty chunks are ignored. */
  append(bytes: ArrayBuffer): void {
    if (bytes.byteLength === 0) {
      return
    }
    this.chunks.push({ offset: this.sent, bytes })
    this.sent += bytes.byteLength
  }

  /**
   * Record a cumulative ack and trim every chunk fully at/below it. Acks are
   * monotonic; a stale/duplicate ack is ignored and an over-ack is clamped to
   * the sent offset. A partially-covered chunk is retained.
   */
  ack(offsetBytes: number): void {
    if (offsetBytes <= this.acked) {
      return
    }
    this.acked = Math.min(offsetBytes, this.sent)
    this.chunks = this.chunks.filter(chunk => chunk.offset + chunk.bytes.byteLength > this.acked)
  }

  /** The unacked chunks, in order — exactly what to resend on reconnect. */
  unacked(): ArrayBuffer[] {
    return this.chunks.map(chunk => chunk.bytes)
  }

  /** Drop everything (fresh start). */
  reset(): void {
    this.chunks = []
    this.sent = 0
    this.acked = 0
  }
}
