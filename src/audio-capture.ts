// Browser audio-capture pipeline for the Scribe recording layer.
//
// Browser-only and React-free: it owns `getUserMedia` (+ optional
// `getDisplayMedia`), a Web Audio `AudioContext`/`ScriptProcessorNode` tap, and
// converts each captured Float32 buffer to PCM16, emitting the bytes via an
// `onChunk` callback. It contains NO wire-protocol logic — the caller (the
// {@link ScribeRecorder}) pipes each chunk into the phase-15 WS client's
// `sendAudio`.
//
// Ported from the capture helpers proven in superscribe-web (mic-only uses
// `getUserMedia`; mic+system adds tab/window audio via `getDisplayMedia` and
// mixes both into a single mono PCM stream). The `AudioContext` is opened at
// {@link STT_SAMPLE_RATE} so the browser resamples for us — no manual
// downsampling.

import { STT_SAMPLE_RATE, floatToPcm16 } from './audio'

/** How the browser captures audio for a recording session. */
export type AudioCaptureMode = 'mic' | 'mic+system'

/** Default ScriptProcessor buffer size (frames) — the proven superscribe-web value. */
export const DEFAULT_AUDIO_BUFFER_SIZE = 4096

export const SYSTEM_AUDIO_CANCELLED =
  'Screen share cancelled — pick a tab or window and enable audio sharing.'
export const SYSTEM_AUDIO_MISSING =
  'No audio in the shared source — in Chrome, check "Share tab audio" or share a tab that is playing audio.'

/** The raw `MediaStream`s captured for a session; tracks must be stopped on teardown. */
export interface CapturedStreams {
  micStream: MediaStream
  /** Present when the mode is `mic+system`. */
  displayStream: MediaStream | null
}

/** The live Web Audio graph tapping the captured streams into a mono processor. */
export interface PcmCapturePipeline {
  audioContext: AudioContext
  processor: ScriptProcessorNode
  streams: CapturedStreams
}

/** Request the microphone for a mic+system session (AEC off — the remote leg is in the display stream). */
export async function captureMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
    },
  })
}

/**
 * Prompt Chrome's display picker for tab/window/screen capture. Video is
 * required by the API but discarded immediately; only the audio track is kept.
 * Throws a friendly error when the user cancels ({@link SYSTEM_AUDIO_CANCELLED})
 * or the shared source has no audio ({@link SYSTEM_AUDIO_MISSING}).
 */
export async function captureSystemAudio(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getDisplayMedia) {
    throw new Error('System audio capture is not supported in this browser.')
  }

  let displayStream: MediaStream
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotAllowedError') {
      throw new Error(SYSTEM_AUDIO_CANCELLED)
    }
    throw error
  }

  for (const track of displayStream.getVideoTracks()) {
    track.stop()
    displayStream.removeTrack(track)
  }

  if (displayStream.getAudioTracks().length === 0) {
    displayStream.getTracks().forEach(track => track.stop())
    throw new Error(SYSTEM_AUDIO_MISSING)
  }

  return displayStream
}

/** Acquire the stream(s) for the requested capture mode. */
export async function captureStreamsForMode(mode: AudioCaptureMode): Promise<CapturedStreams> {
  if (mode === 'mic') {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    })
    return { micStream, displayStream: null }
  }

  const [micStream, displayStream] = await Promise.all([captureMicrophone(), captureSystemAudio()])
  return { micStream, displayStream }
}

/** Wire mic (+ optional system) streams into a mono `ScriptProcessor` tap. */
export function createPcmCapturePipeline(
  streams: CapturedStreams,
  bufferSize: number
): PcmCapturePipeline {
  const audioContext = new AudioContext({ sampleRate: STT_SAMPLE_RATE })
  const processor = audioContext.createScriptProcessor(bufferSize, 1, 1)
  const mixer = audioContext.createGain()

  const micSource = audioContext.createMediaStreamSource(streams.micStream)
  micSource.connect(mixer)

  if (streams.displayStream) {
    const systemSource = audioContext.createMediaStreamSource(streams.displayStream)
    systemSource.connect(mixer)
  }

  mixer.connect(processor)
  processor.connect(audioContext.destination)

  return { audioContext, processor, streams }
}

/** Stop every track on the captured streams. */
export function stopCapturedStreams(streams: CapturedStreams | null): void {
  if (!streams) {
    return
  }
  streams.micStream.getTracks().forEach(track => track.stop())
  streams.displayStream?.getTracks().forEach(track => track.stop())
}

/** The subset of {@link AudioCapture} the {@link ScribeRecorder} depends on (a test seam). */
export interface AudioCaptureLike {
  start(): Promise<void>
  stop(): void
  isCapturing(): boolean
}

export interface AudioCaptureOptions {
  /** Invoked with each PCM16 chunk (`ArrayBuffer`) produced by the mic tap. */
  onChunk: (pcm16: ArrayBuffer) => void
  /** Capture mode. Defaults to `'mic'`. */
  mode?: AudioCaptureMode
  /** ScriptProcessor buffer size (frames). Defaults to {@link DEFAULT_AUDIO_BUFFER_SIZE}. */
  bufferSize?: number

  // --- test / runtime seams (default to the DOM implementations above) ---
  /** Acquire the capture streams. Defaults to {@link captureStreamsForMode}. */
  captureStreams?: (mode: AudioCaptureMode) => Promise<CapturedStreams>
  /** Build the Web Audio graph. Defaults to {@link createPcmCapturePipeline}. */
  createPipeline?: (streams: CapturedStreams, bufferSize: number) => PcmCapturePipeline
  /** Stop the captured streams. Defaults to {@link stopCapturedStreams}. */
  stopStreams?: (streams: CapturedStreams | null) => void
}

/**
 * The browser microphone → PCM16 capture pipeline as a small lifecycle object:
 * `start()` acquires the mic (+ optional system audio) and begins emitting
 * PCM16 chunks via `onChunk`; `stop()` tears the graph down and releases the
 * mic. Re-`start()`-able (used to resume after a pause).
 */
export class AudioCapture implements AudioCaptureLike {
  private readonly onChunk: (pcm16: ArrayBuffer) => void
  private readonly mode: AudioCaptureMode
  private readonly bufferSize: number
  private readonly captureStreams: (mode: AudioCaptureMode) => Promise<CapturedStreams>
  private readonly createPipeline: (
    streams: CapturedStreams,
    bufferSize: number
  ) => PcmCapturePipeline
  private readonly stopStreams: (streams: CapturedStreams | null) => void

  private pipeline: PcmCapturePipeline | null = null
  private streams: CapturedStreams | null = null
  private capturing = false

  constructor(opts: AudioCaptureOptions) {
    if (typeof opts?.onChunk !== 'function') {
      throw new Error('onChunk is required')
    }
    this.onChunk = opts.onChunk
    this.mode = opts.mode ?? 'mic'
    this.bufferSize = opts.bufferSize ?? DEFAULT_AUDIO_BUFFER_SIZE
    this.captureStreams = opts.captureStreams ?? captureStreamsForMode
    this.createPipeline = opts.createPipeline ?? createPcmCapturePipeline
    this.stopStreams = opts.stopStreams ?? stopCapturedStreams
  }

  isCapturing(): boolean {
    return this.capturing
  }

  /** Acquire the mic and start emitting PCM16 chunks. No-op if already capturing. */
  async start(): Promise<void> {
    if (this.capturing) {
      return
    }
    const streams = await this.captureStreams(this.mode)
    this.streams = streams
    let pipeline: PcmCapturePipeline
    try {
      pipeline = this.createPipeline(streams, this.bufferSize)
    } catch (error) {
      // The audio graph failed to build — release the mic we just acquired.
      this.stopStreams(streams)
      this.streams = null
      throw error
    }
    this.pipeline = pipeline
    pipeline.processor.onaudioprocess = event => {
      const channel = event.inputBuffer.getChannelData(0)
      this.onChunk(floatToPcm16(channel))
    }
    this.capturing = true
  }

  /** Stop the tap and release the mic (+ optional system) streams. */
  stop(): void {
    if (this.pipeline) {
      this.pipeline.processor.onaudioprocess = null
      try {
        this.pipeline.processor.disconnect()
      } catch {
        // ignore — teardown proceeds regardless.
      }
      void Promise.resolve(this.pipeline.audioContext.close()).catch(() => undefined)
      this.pipeline = null
    }
    this.stopStreams(this.streams)
    this.streams = null
    this.capturing = false
  }
}
