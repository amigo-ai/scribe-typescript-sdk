import { describe, expect, it } from 'vitest'
import { AudioRingBuffer } from '../src/ring-buffer'

function chunk(size: number): ArrayBuffer {
  return new ArrayBuffer(size)
}

describe('AudioRingBuffer', () => {
  it('tracks sent and pending bytes on append', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10))
    ring.append(chunk(20))
    expect(ring.sentBytes).toBe(30)
    expect(ring.pendingBytes).toBe(30)
    expect(ring.ackedBytes).toBe(0)
  })

  it('ignores empty appends', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(0))
    expect(ring.sentBytes).toBe(0)
    expect(ring.unacked()).toHaveLength(0)
  })

  it('trims fully-acked chunks, keeping only unacked audio', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10)) // [0,10)
    ring.append(chunk(10)) // [10,20)
    ring.append(chunk(10)) // [20,30)
    ring.ack(20)
    expect(ring.ackedBytes).toBe(20)
    expect(ring.pendingBytes).toBe(10)
    expect(ring.unacked()).toHaveLength(1)
  })

  it('retains a partially-covered chunk', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10)) // [0,10)
    ring.append(chunk(10)) // [10,20)
    ring.ack(15) // covers first chunk fully, second partially
    expect(ring.unacked()).toHaveLength(1)
    expect(ring.unacked()[0]!.byteLength).toBe(10)
  })

  it('ignores stale / duplicate acks (monotonic)', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10))
    ring.append(chunk(10))
    ring.ack(20)
    ring.ack(10) // stale
    ring.ack(20) // duplicate
    expect(ring.ackedBytes).toBe(20)
    expect(ring.unacked()).toHaveLength(0)
  })

  it('clamps an over-ack to the sent offset', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10))
    ring.ack(999)
    expect(ring.ackedBytes).toBe(10)
    expect(ring.pendingBytes).toBe(0)
  })

  it('resend-unacked returns exactly the unacked chunks in order', () => {
    const ring = new AudioRingBuffer()
    const a = chunk(10)
    const b = chunk(10)
    const c = chunk(10)
    ring.append(a)
    ring.append(b)
    ring.append(c)
    ring.ack(10) // drops a
    expect(ring.unacked()).toEqual([b, c])
  })

  it('reset clears all state', () => {
    const ring = new AudioRingBuffer()
    ring.append(chunk(10))
    ring.ack(5)
    ring.reset()
    expect(ring.sentBytes).toBe(0)
    expect(ring.ackedBytes).toBe(0)
    expect(ring.pendingBytes).toBe(0)
    expect(ring.unacked()).toHaveLength(0)
  })
})
