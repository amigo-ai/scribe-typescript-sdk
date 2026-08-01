import { describe, expect, it, vi } from 'vitest'
import type { AudioCaptureLike, AudioCaptureOptions } from '../src/audio-capture'
import type { SttTranscriptSegment } from '../src/normalize'
import { ScribeRecorder } from '../src/recorder'
import type {
  ScribeRecorderOptions,
  ScribeRecorderStatus,
  ScribeStreamClientLike,
} from '../src/recorder'
import type { ScribeStreamClientOptions, ScribeStreamState } from '../src/stream-client'

/** A fake phase-15 client capturing the wired callbacks + recording every call. */
class FakeClient implements ScribeStreamClientLike {
  state: ScribeStreamState = 'idle'
  audio: Array<ArrayBuffer | Uint8Array> = []
  calls: string[] = []
  connectImpl: (() => Promise<void>) | null = null
  private readonly opts: ScribeStreamClientOptions

  constructor(opts: ScribeStreamClientOptions) {
    this.opts = opts
  }

  async connect(): Promise<void> {
    this.calls.push('connect')
    this.setState('connecting')
    if (this.connectImpl) {
      await this.connectImpl()
    }
    this.setState('streaming')
  }
  sendAudio(pcm16: ArrayBuffer | Uint8Array): void {
    this.audio.push(pcm16)
  }
  pause(): void {
    this.calls.push('pause')
    this.setState('paused')
  }
  resume(): void {
    this.calls.push('resume')
    this.setState('streaming')
  }
  end(): void {
    this.calls.push('end')
    this.setState('ended')
  }
  destroy(): void {
    this.calls.push('destroy')
    if (this.state !== 'ended' && this.state !== 'failed') {
      this.setState('idle')
    }
  }
  getState(): ScribeStreamState {
    return this.state
  }

  // --- drivers (simulate the server / transport) ---
  setState(next: ScribeStreamState): void {
    this.state = next
    this.opts.onStateChange?.(next)
  }
  emitTurn(segment: SttTranscriptSegment): void {
    this.opts.onTurn?.(segment)
  }
  emitReconnect(): void {
    this.opts.onReconnect?.()
  }
  fail(error: Error): void {
    this.setState('failed')
    this.opts.onError?.(error)
  }
}

/** A fake mic capturing its onChunk sink and letting a test emit PCM16 chunks. */
class FakeMic implements AudioCaptureLike {
  capturing = false
  startCount = 0
  stopCount = 0
  startImpl: (() => Promise<void>) | null = null
  private readonly onChunk: (pcm16: ArrayBuffer) => void

  constructor(opts: AudioCaptureOptions) {
    this.onChunk = opts.onChunk
  }

  async start(): Promise<void> {
    this.startCount += 1
    if (this.startImpl) {
      await this.startImpl()
    }
    this.capturing = true
  }
  stop(): void {
    this.stopCount += 1
    this.capturing = false
  }
  isCapturing(): boolean {
    return this.capturing
  }

  /** Simulate a captured PCM16 chunk reaching the wired sink. */
  emit(pcm16: ArrayBuffer): void {
    this.onChunk(pcm16)
  }
}

interface Harness {
  recorder: ScribeRecorder
  client: FakeClient
  mic: FakeMic
  turns: SttTranscriptSegment[]
  errors: Error[]
  statuses: ScribeRecorderStatus[]
  reconnectCount: () => number
}

function makeRecorder(overrides: Partial<ScribeRecorderOptions> = {}): Harness {
  const turns: SttTranscriptSegment[] = []
  const errors: Error[] = []
  const statuses: ScribeRecorderStatus[] = []
  const counters = { reconnects: 0 }
  let client!: FakeClient
  let mic!: FakeMic

  const recorder = new ScribeRecorder({
    sessionId: 'sess-1',
    ticketProvider: async () => ({ ticket: 't' }),
    allocateProvider: async () => ({ host: 'h', expiresAt: 'e' }),
    onTurn: t => turns.push(t),
    onError: e => errors.push(e),
    onStateChange: s => statuses.push(s),
    onReconnect: () => {
      counters.reconnects += 1
    },
    clientFactory: opts => {
      client = new FakeClient(opts)
      return client
    },
    captureFactory: opts => {
      mic = new FakeMic(opts)
      return mic
    },
    ...overrides,
  })
  return {
    recorder,
    client,
    mic,
    turns,
    errors,
    statuses,
    reconnectCount: () => counters.reconnects,
  }
}

function pcm(size: number): ArrayBuffer {
  return new ArrayBuffer(size)
}

describe('ScribeRecorder', () => {
  it('passes sessionId + attach-ticket seams straight through to the client', () => {
    const ticketProvider = vi.fn(async () => ({ ticket: 't' }))
    const allocateProvider = vi.fn(async () => ({ host: 'h', expiresAt: 'e' }))
    const clientFactory = vi.fn((opts: ScribeStreamClientOptions) => new FakeClient(opts))
    new ScribeRecorder({
      sessionId: 'sess-9',
      ticketProvider,
      allocateProvider,
      clientFactory,
    })
    expect(clientFactory).toHaveBeenCalledTimes(1)
    const passed = clientFactory.mock.calls[0]![0]
    expect(passed.sessionId).toBe('sess-9')
    expect(passed.ticketProvider).toBe(ticketProvider)
    expect(passed.allocateProvider).toBe(allocateProvider)
  })

  it('start() connects the client and starts the mic (idle → recording)', async () => {
    const h = makeRecorder()
    expect(h.recorder.getState()).toBe('idle')
    await h.recorder.start()
    expect(h.client.calls).toContain('connect')
    expect(h.mic.isCapturing()).toBe(true)
    expect(h.recorder.getState()).toBe('recording')
    expect(h.recorder.getStatus()).toMatchObject({
      state: 'recording',
      streamState: 'streaming',
      micPermission: 'granted',
      capturing: true,
    })
  })

  it('pipes captured PCM16 chunks into client.sendAudio', async () => {
    const h = makeRecorder()
    await h.recorder.start()
    const a = pcm(100)
    const b = pcm(50)
    h.mic.emit(a)
    h.mic.emit(b)
    expect(h.client.audio).toEqual([a, b])
  })

  it('pause()/resume() drive both capture and client control (recording ↔ paused)', async () => {
    const h = makeRecorder()
    await h.recorder.start()

    h.recorder.pause()
    expect(h.recorder.getState()).toBe('paused')
    expect(h.client.calls).toContain('pause')
    expect(h.mic.stopCount).toBe(1)
    expect(h.mic.isCapturing()).toBe(false)

    await h.recorder.resume()
    expect(h.recorder.getState()).toBe('recording')
    expect(h.client.calls).toContain('resume')
    expect(h.mic.startCount).toBe(2) // start + resume
    expect(h.mic.isCapturing()).toBe(true)
  })

  it('end() stops capture and finalizes the client (→ ended)', async () => {
    const h = makeRecorder()
    await h.recorder.start()
    h.recorder.end()
    expect(h.recorder.getState()).toBe('ended')
    expect(h.client.calls).toContain('end')
    expect(h.mic.isCapturing()).toBe(false)
  })

  it('forwards onTurn and onReconnect from the client; capture keeps running on reconnect', async () => {
    const h = makeRecorder()
    await h.recorder.start()

    const seg: SttTranscriptSegment = {
      ordinal: 1,
      speaker: 'Dr',
      text: 'hello',
      final: true,
      timestamp: 2,
    }
    h.client.emitTurn(seg)
    expect(h.turns).toEqual([seg])

    // Transport blips through reconnecting → streaming; the recorder stays
    // 'recording' and the mic never stops (client resends unacked audio).
    h.client.setState('reconnecting')
    h.client.emitReconnect()
    h.client.setState('streaming')
    expect(h.reconnectCount()).toBe(1)
    expect(h.recorder.getState()).toBe('recording')
    expect(h.mic.isCapturing()).toBe(true)
    h.mic.emit(pcm(10))
    expect(h.client.audio).toHaveLength(1)
  })

  it('permission-denied path: start() rejects, mic denied, client destroyed (→ failed)', async () => {
    const h = makeRecorder()
    h.mic.startImpl = () => Promise.reject(new DOMException('denied', 'NotAllowedError'))
    await expect(h.recorder.start()).rejects.toThrow()
    expect(h.recorder.getState()).toBe('failed')
    expect(h.recorder.getStatus().micPermission).toBe('denied')
    expect(h.recorder.getStatus().capturing).toBe(false)
    expect(h.client.calls).toContain('destroy')
    expect(h.errors).toHaveLength(1)
  })

  it('a client failure fails the recorder and stops capture', async () => {
    const h = makeRecorder()
    await h.recorder.start()
    h.client.fail(new Error('stream lost — exhausted'))
    expect(h.recorder.getState()).toBe('failed')
    expect(h.mic.isCapturing()).toBe(false)
    expect(h.errors.map(e => e.message)).toContain('stream lost — exhausted')
  })

  it('a server-initiated clean close ends the recorder', async () => {
    const h = makeRecorder()
    await h.recorder.start()
    h.client.setState('ended')
    expect(h.recorder.getState()).toBe('ended')
    expect(h.mic.isCapturing()).toBe(false)
  })

  it('start() is a no-op once recording', async () => {
    const h = makeRecorder()
    await h.recorder.start()
    await h.recorder.start()
    expect(h.client.calls.filter(c => c === 'connect')).toHaveLength(1)
  })

  it('surfaces an initial connect failure (→ failed) and rethrows', async () => {
    const h = makeRecorder()
    h.client.connectImpl = () => Promise.reject(new Error('allocate 503'))
    await expect(h.recorder.start()).rejects.toThrow('allocate 503')
    expect(h.recorder.getState()).toBe('failed')
    expect(h.errors).toHaveLength(1)
  })
})
