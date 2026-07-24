import { afterEach, describe, expect, it, vi } from 'vitest'
import { AudioCapture, captureStreamsForMode, captureSystemAudio } from '../src/audio-capture'
import type { CapturedStreams, PcmCapturePipeline } from '../src/audio-capture'

type ProcessCb =
  ((event: { inputBuffer: { getChannelData: (c: number) => Float32Array } }) => void) | null

/** A fake Web Audio graph whose `onaudioprocess` can be driven from a test. */
function makeFakePipeline() {
  const disconnect = vi.fn()
  const close = vi.fn(() => Promise.resolve())
  const processor = { onaudioprocess: null as ProcessCb, disconnect }
  const audioContext = { close }
  const streams: CapturedStreams = {
    micStream: {} as MediaStream,
    displayStream: null,
  }
  const pipeline = { audioContext, processor, streams } as unknown as PcmCapturePipeline
  return { pipeline, processor, disconnect, close, streams }
}

describe('AudioCapture', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requires an onChunk callback', () => {
    expect(() => new AudioCapture({} as never)).toThrow(/onChunk/)
  })

  it('pipes each captured Float32 buffer through floatToPcm16 to onChunk', async () => {
    const chunks: ArrayBuffer[] = []
    const fake = makeFakePipeline()
    const capture = new AudioCapture({
      onChunk: c => chunks.push(c),
      captureStreams: async () => fake.streams,
      createPipeline: () => fake.pipeline,
      stopStreams: vi.fn(),
    })

    await capture.start()
    expect(capture.isCapturing()).toBe(true)
    expect(typeof fake.processor.onaudioprocess).toBe('function')

    fake.processor.onaudioprocess!({
      inputBuffer: { getChannelData: () => new Float32Array([1, -1, 0]) },
    })
    expect(chunks).toHaveLength(1)
    expect(Array.from(new Int16Array(chunks[0]!))).toEqual([32767, -32768, 0])
  })

  it('is a no-op when start() is called while already capturing', async () => {
    const fake = makeFakePipeline()
    const captureStreams = vi.fn(async () => fake.streams)
    const capture = new AudioCapture({
      onChunk: () => undefined,
      captureStreams,
      createPipeline: () => fake.pipeline,
      stopStreams: vi.fn(),
    })
    await capture.start()
    await capture.start()
    expect(captureStreams).toHaveBeenCalledTimes(1)
  })

  it('tears down the graph and releases the streams on stop()', async () => {
    const fake = makeFakePipeline()
    const stopStreams = vi.fn()
    const capture = new AudioCapture({
      onChunk: () => undefined,
      captureStreams: async () => fake.streams,
      createPipeline: () => fake.pipeline,
      stopStreams,
    })
    await capture.start()
    capture.stop()
    expect(fake.disconnect).toHaveBeenCalledTimes(1)
    expect(fake.close).toHaveBeenCalledTimes(1)
    expect(stopStreams).toHaveBeenCalledWith(fake.streams)
    expect(fake.processor.onaudioprocess).toBeNull()
    expect(capture.isCapturing()).toBe(false)
  })

  it('releases the mic when the audio graph fails to build', async () => {
    const stopStreams = vi.fn()
    const streams: CapturedStreams = { micStream: {} as MediaStream, displayStream: null }
    const capture = new AudioCapture({
      onChunk: () => undefined,
      captureStreams: async () => streams,
      createPipeline: () => {
        throw new Error('no AudioContext')
      },
      stopStreams,
    })
    await expect(capture.start()).rejects.toThrow('no AudioContext')
    expect(stopStreams).toHaveBeenCalledWith(streams)
    expect(capture.isCapturing()).toBe(false)
  })
})

describe('captureStreamsForMode', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests the mic with AEC enabled in mic mode', async () => {
    const getUserMedia = vi.fn(async () => ({}) as MediaStream)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    const streams = await captureStreamsForMode('mic')
    expect(streams.displayStream).toBeNull()
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
  })
})

describe('captureSystemAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('throws when the browser lacks getDisplayMedia', async () => {
    vi.stubGlobal('navigator', { mediaDevices: {} })
    await expect(captureSystemAudio()).rejects.toThrow(/not supported/)
  })
})
