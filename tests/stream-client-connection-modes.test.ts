import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ScribeStreamClient } from '../src/stream-client'
import type { ScribeStreamClientOptions } from '../src/stream-client'
import { MockWs } from './mock-ws'

function make(overrides: Partial<ScribeStreamClientOptions>): ScribeStreamClient {
  return new ScribeStreamClient({
    sessionId: 'sess-1',
    webSocketFactory: (url, protocols) => new MockWs(url, protocols),
    reconnectDelayMs: () => 1,
    keepaliveIntervalMs: 20,
    ...overrides,
  } as ScribeStreamClientOptions)
}

describe('ScribeStreamClient connection modes', () => {
  beforeEach(() => {
    MockWs.reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  describe('connectionProvider (unified seam)', () => {
    it('resolves host + ticket in one call and opens the WS with ["auth", ticket]', async () => {
      const connectionProvider = vi.fn(async (sessionId: string) => ({
        host: `host-${sessionId}`,
        ticket: 'ticket-1',
        hostExpiresAt: 'h',
        ticketExpiresAt: 't',
      }))
      const client = make({ connectionProvider })
      await client.connect()

      const ws = MockWs.last()
      expect(connectionProvider).toHaveBeenCalledWith('sess-1')
      expect(ws.protocols).toEqual(['auth', 'ticket-1'])
      expect(ws.url).toBe('wss://host-sess-1/agent/stream/connect?session_id=sess-1')
      ws.open()
      expect(client.getState()).toBe('streaming')
    })

    it('re-invokes connectionProvider on reconnect (fresh host + ticket)', async () => {
      let n = 0
      const connectionProvider = vi.fn(async () => {
        n += 1
        return { host: `host-${n}`, ticket: `ticket-${n}` }
      })
      const client = make({ connectionProvider })
      await client.connect()
      MockWs.last().open()
      MockWs.last().serverClose(1012)
      await vi.advanceTimersByTimeAsync(5)

      expect(connectionProvider).toHaveBeenCalledTimes(2)
      const ws2 = MockWs.last()
      expect(ws2.protocols).toEqual(['auth', 'ticket-2'])
      expect(ws2.url).toBe('wss://host-2/agent/stream/connect?session_id=sess-1')
    })
  })

  describe('static host + ticket (one-shot)', () => {
    it('attaches with the provided host + ticket', async () => {
      const client = make({ host: 'gs-1.actors.example', ticket: 'static-ticket' })
      await client.connect()
      const ws = MockWs.last()
      expect(ws.protocols).toEqual(['auth', 'static-ticket'])
      expect(ws.url).toBe('wss://gs-1.actors.example/agent/stream/connect?session_id=sess-1')
    })

    it('reuses the same static host + ticket on reconnect', async () => {
      const client = make({ host: 'gs-1.actors.example', ticket: 'static-ticket' })
      await client.connect()
      MockWs.last().open()
      MockWs.last().serverClose(1006)
      await vi.advanceTimersByTimeAsync(5)
      const ws2 = MockWs.last()
      expect(MockWs.instances).toHaveLength(2)
      expect(ws2.protocols).toEqual(['auth', 'static-ticket'])
    })
  })

  describe('construction validation', () => {
    it('throws when connectionProvider is not a function', () => {
      expect(() =>
        make({
          connectionProvider: 'nope' as unknown as ScribeStreamClientOptions['connectionProvider'],
        })
      ).toThrow(/connectionProvider/)
    })

    it('throws when only one of host / ticket is given', () => {
      expect(() => make({ host: 'h' })).toThrow(/host and ticket/)
      expect(() => make({ ticket: 't' })).toThrow(/host and ticket/)
    })

    it('still requires the split seams when no other mode is supplied', () => {
      expect(() => make({})).toThrow(/ticketProvider/)
    })
  })
})
