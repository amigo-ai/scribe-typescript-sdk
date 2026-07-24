import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RECONNECT } from '../src/backoff'
import type { SttTranscriptSegment } from '../src/normalize'
import { ScribeStreamClient } from '../src/stream-client'
import type { ScribeStreamClientOptions, ScribeStreamState } from '../src/stream-client'
import { MockWs } from './mock-ws'

function pcm(size: number): ArrayBuffer {
  return new ArrayBuffer(size)
}

interface Harness {
  client: ScribeStreamClient
  turns: SttTranscriptSegment[]
  errors: Error[]
  states: ScribeStreamState[]
  reconnectCount: () => number
  ticketProvider: ReturnType<typeof vi.fn>
  allocateProvider: ReturnType<typeof vi.fn>
}

/**
 * Build a client wired to {@link MockWs}, with `ticketProvider` /
 * `allocateProvider` returning DISTINCT values per call (`ticket-1`/`host-1`,
 * `ticket-2`/`host-2`, ...) so a reconnect's fresh-ticket + fresh-host can be
 * asserted.
 */
function makeClient(overrides: Partial<ScribeStreamClientOptions> = {}): Harness {
  const turns: SttTranscriptSegment[] = []
  const errors: Error[] = []
  const states: ScribeStreamState[] = []
  const counters = { reconnects: 0 }
  let ticketN = 0
  let hostN = 0
  const ticketProvider = vi.fn(async () => ({ ticket: `ticket-${++ticketN}`, expiresAt: 'x' }))
  const allocateProvider = vi.fn(async () => ({ host: `host-${++hostN}`, expiresAt: 'y' }))
  const client = new ScribeStreamClient({
    sessionId: 'sess-1',
    ticketProvider,
    allocateProvider,
    onTurn: t => turns.push(t),
    onError: e => errors.push(e),
    onStateChange: s => states.push(s),
    onReconnect: () => {
      counters.reconnects += 1
    },
    webSocketFactory: (url, protocols) => new MockWs(url, protocols),
    reconnectDelayMs: () => 1,
    keepaliveIntervalMs: 20,
    ...overrides,
  })
  return {
    client,
    turns,
    errors,
    states,
    reconnectCount: () => counters.reconnects,
    ticketProvider,
    allocateProvider,
  }
}

describe('ScribeStreamClient', () => {
  beforeEach(() => {
    MockWs.reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('requires sessionId, ticketProvider, and allocateProvider', () => {
    const ok = {
      sessionId: 's',
      ticketProvider: async () => ({ ticket: 't' }),
      allocateProvider: async () => ({ host: 'h', expiresAt: 'e' }),
    }
    expect(() => new ScribeStreamClient({ ...ok, sessionId: '' })).toThrow(/sessionId/)
    expect(
      () =>
        new ScribeStreamClient({
          ...ok,
          ticketProvider: undefined as unknown as ScribeStreamClientOptions['ticketProvider'],
        })
    ).toThrow(/ticketProvider/)
    expect(
      () =>
        new ScribeStreamClient({
          ...ok,
          allocateProvider: undefined as unknown as ScribeStreamClientOptions['allocateProvider'],
        })
    ).toThrow(/allocateProvider/)
  })

  it('allocates + mints a ticket, opens the WS with ["auth", ticket], and sends resume_from 0', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    expect(h.allocateProvider).toHaveBeenCalledWith('sess-1')
    expect(h.ticketProvider).toHaveBeenCalledWith('sess-1')
    expect(ws.protocols).toEqual(['auth', 'ticket-1'])
    expect(ws.url).toBe('wss://host-1/agent/stream/connect?session_id=sess-1')
    expect(ws.binaryType).toBe('arraybuffer')

    ws.open()
    expect(h.client.getState()).toBe('streaming')
    expect(ws.jsonSent()).toContainEqual({ type: 'resume_from', acked_offset_bytes: 0 })
  })

  it('sends binary audio and trims the ring buffer on ack', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    h.client.sendAudio(pcm(100))
    expect(ws.binarySent()).toHaveLength(1)
    expect(ws.binarySent()[0]!.byteLength).toBe(100)
    ws.message({ type: 'ack', audio_offset_bytes: 100 })
    expect(h.client.getAckedBytes()).toBe(100)
  })

  it('accepts Uint8Array PCM and sends its exact bytes', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    h.client.sendAudio(new Uint8Array([1, 2, 3, 4]))
    expect(ws.binarySent()).toHaveLength(1)
    expect(ws.binarySent()[0]!.byteLength).toBe(4)
  })

  it('normalizes interim then final segments into onTurn', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    ws.message({ type: 'interim_transcript', ordinal: 3, speaker: 'Dr', text: 'hel' })
    ws.message({
      type: 'transcript_segment',
      ordinal: 3,
      speaker: 'Dr',
      text: 'hello',
      final: true,
      timestamp: 5,
    })
    expect(h.turns).toEqual([
      { ordinal: 3, speaker: 'Dr', text: 'hel', final: false, timestamp: null },
      { ordinal: 3, speaker: 'Dr', text: 'hello', final: true, timestamp: 5 },
    ])
  })

  it('sends an app-level {type:"ping"} on the keepalive interval', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    await vi.advanceTimersByTimeAsync(20)
    expect(ws.jsonSent()).toContainEqual({ type: 'ping' })
  })

  it('pause/resume/end send control frames and transition state; pause keeps the WS open', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    h.client.pause()
    expect(h.client.getState()).toBe('paused')
    expect(ws.readyState).toBe(1)
    h.client.resume()
    expect(h.client.getState()).toBe('streaming')
    h.client.end()
    expect(h.client.getState()).toBe('ended')
    const types = ws.jsonSent().map(f => f.type)
    expect(types).toContain('pause')
    expect(types).toContain('resume')
    expect(types).toContain('end')
  })

  it('reconnects on 1012 with a fresh ticket + host, resends only unacked audio, fires onReconnect', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws1 = MockWs.last()
    ws1.open()
    h.client.sendAudio(pcm(50)) // [0,50)
    h.client.sendAudio(pcm(50)) // [50,100)
    ws1.message({ type: 'ack', audio_offset_bytes: 50 }) // first chunk fully acked
    expect(h.client.getAckedBytes()).toBe(50)

    ws1.serverClose(1012)
    expect(h.client.getState()).toBe('reconnecting')
    await vi.advanceTimersByTimeAsync(5)

    const ws2 = MockWs.last()
    expect(ws2).not.toBe(ws1)
    // ticket + host re-fetched on reconnect (distinct values).
    expect(h.allocateProvider).toHaveBeenCalledTimes(2)
    expect(h.ticketProvider).toHaveBeenCalledTimes(2)
    expect(ws2.protocols).toEqual(['auth', 'ticket-2'])
    expect(ws2.url).toBe('wss://host-2/agent/stream/connect?session_id=sess-1')

    ws2.open()
    expect(ws2.jsonSent()).toContainEqual({ type: 'resume_from', acked_offset_bytes: 50 })
    expect(ws2.binarySent()).toHaveLength(1) // only the unacked 50-byte chunk
    expect(ws2.binarySent()[0]!.byteLength).toBe(50)
    expect(h.reconnectCount()).toBe(1)
    expect(h.client.getState()).toBe('streaming')
  })

  it('reconnects on abnormal 1006', async () => {
    const h = makeClient()
    await h.client.connect()
    MockWs.last().open()
    MockWs.last().serverClose(1006)
    await vi.advanceTimersByTimeAsync(5)
    expect(MockWs.instances).toHaveLength(2)
  })

  it('does not reconnect on 4009 (terminal) — fails', async () => {
    const h = makeClient()
    await h.client.connect()
    MockWs.last().open()
    MockWs.last().serverClose(4009)
    await vi.advanceTimersByTimeAsync(50)
    expect(MockWs.instances).toHaveLength(1)
    expect(h.client.getState()).toBe('failed')
    expect(h.errors).toHaveLength(1)
  })

  it('does not reconnect on 4001 (auth) — fails', async () => {
    const h = makeClient()
    await h.client.connect()
    MockWs.last().open()
    MockWs.last().serverClose(4001)
    await vi.advanceTimersByTimeAsync(50)
    expect(MockWs.instances).toHaveLength(1)
    expect(h.client.getState()).toBe('failed')
    expect(h.errors).toHaveLength(1)
  })

  it('treats a server-initiated 1000 as a clean end (no error, no reconnect)', async () => {
    const h = makeClient()
    await h.client.connect()
    MockWs.last().open()
    MockWs.last().serverClose(1000)
    await vi.advanceTimersByTimeAsync(50)
    expect(MockWs.instances).toHaveLength(1)
    expect(h.client.getState()).toBe('ended')
    expect(h.errors).toHaveLength(0)
  })

  it('never reconnects after an intentional end()', async () => {
    const h = makeClient()
    await h.client.connect()
    const ws = MockWs.last()
    ws.open()
    h.client.end()
    await vi.advanceTimersByTimeAsync(50)
    expect(MockWs.instances).toHaveLength(1)
    expect(h.client.getState()).toBe('ended')
  })

  it('gives up (fails) after maxAttempts consecutive reconnectable closes', async () => {
    const h = makeClient()
    await h.client.connect()
    MockWs.last().open()
    // Close repeatedly without ever re-opening → attempts accrue up to the cap.
    for (let i = 0; i < RECONNECT.maxAttempts; i++) {
      MockWs.last().serverClose(1012)
      await vi.advanceTimersByTimeAsync(5)
    }
    // One more close with attempts exhausted → terminal failure.
    MockWs.last().serverClose(1012)
    expect(h.client.getState()).toBe('failed')
    expect(h.errors.some(e => /exhausted/.test(e.message))).toBe(true)
  })

  it('surfaces an initial connect failure (allocate throws) and rethrows', async () => {
    const h = makeClient({
      allocateProvider: vi.fn(async () => {
        throw new Error('allocate 503')
      }),
    })
    await expect(h.client.connect()).rejects.toThrow('allocate 503')
    expect(h.client.getState()).toBe('failed')
    expect(h.errors).toHaveLength(1)
  })
})
