import { describe, expect, it } from 'vitest'
import { RECONNECT, backoffDelayMs } from '../src/backoff'

describe('backoffDelayMs', () => {
  it('grows exponentially from the base delay', () => {
    expect(backoffDelayMs(0)).toBe(1_000)
    expect(backoffDelayMs(1)).toBe(2_000)
    expect(backoffDelayMs(2)).toBe(4_000)
    expect(backoffDelayMs(3)).toBe(8_000)
    expect(backoffDelayMs(4)).toBe(16_000)
  })

  it('caps at maxDelayMs (ceiling below the 300s reconnect grace)', () => {
    expect(backoffDelayMs(5)).toBe(RECONNECT.maxDelayMs)
    expect(backoffDelayMs(50)).toBe(RECONNECT.maxDelayMs)
    expect(RECONNECT.maxDelayMs).toBeLessThan(300_000)
  })

  it('bounds cumulative backoff across all attempts under the grace window', () => {
    let total = 0
    for (let i = 0; i < RECONNECT.maxAttempts; i++) {
      total += backoffDelayMs(i)
    }
    expect(total).toBeLessThan(300_000)
  })
})
