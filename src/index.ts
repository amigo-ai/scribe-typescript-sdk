/**
 * @amigo-ai/scribe — framework-agnostic TypeScript SDK for the Amigo Scribe
 * streaming service.
 *
 * Ships two layers:
 *  - the CRUD REST client ({@link ScribeClient}): create-session, allocate,
 *    transcript + artifacts.
 *  - the recording-independent streaming WebSocket API client
 *    ({@link ScribeStreamClient}): attach-ticket transport, PCM16 send, control
 *    frames, keepalive, and resumable reconnect — fed caller-supplied PCM16
 *    bytes (no audio capture; the browser recorder is a separate phase). Plus
 *    the pure transcript core (wire contract, {@link normalizeTurn},
 *    {@link transcriptReducer}, {@link buildWsUrl}).
 */

// --- CRUD REST client ---
export { ScribeClient } from './client'
export type { ScribeClientConfig, CallOptions } from './client'
export type { FetchLike, TokenProvider, RequestOptions } from './http'
export { HttpClient } from './http'
export * from './types'
export * from './errors'

// --- Streaming WebSocket API client ---
export { ScribeStreamClient } from './stream-client'
export type {
  ScribeStreamClientOptions,
  ScribeStreamState,
  AttachTicket,
  StreamAllocation,
  WsLike,
} from './stream-client'

// --- Transcript core ---
export { normalizeTurn } from './normalize'
export type { SttTranscriptSegment } from './normalize'
export { transcriptReducer, initialTranscriptState, resetTranscript } from './transcript-reducer'
export type { TranscriptState } from './transcript-reducer'
export { AudioRingBuffer } from './ring-buffer'
export { buildWsUrl } from './ws-url'
export { backoffDelayMs, RECONNECT } from './backoff'

// --- Browser recording layer (phase 16) ---
export { floatToPcm16, STT_SAMPLE_RATE } from './audio'
export {
  AudioCapture,
  captureMicrophone,
  captureSystemAudio,
  captureStreamsForMode,
  createPcmCapturePipeline,
  stopCapturedStreams,
  DEFAULT_AUDIO_BUFFER_SIZE,
  SYSTEM_AUDIO_CANCELLED,
  SYSTEM_AUDIO_MISSING,
} from './audio-capture'
export type {
  AudioCaptureMode,
  AudioCaptureOptions,
  AudioCaptureLike,
  CapturedStreams,
  PcmCapturePipeline,
} from './audio-capture'
export { ScribeRecorder } from './recorder'
export type {
  ScribeRecorderOptions,
  ScribeRecorderState,
  ScribeRecorderStatus,
  MicPermission,
  ScribeStreamClientLike,
} from './recorder'

// --- Wire contract (MASTER decisions 11–12) ---
export {
  WS_CONNECT_PATH,
  CLIENT_FRAME,
  SERVER_MESSAGE,
  CLOSE_CODE,
  shouldReconnect,
  KEEPALIVE_INTERVAL_MS,
} from './wire'
export type {
  ClientFrameType,
  ServerMessageType,
  CloseCode,
  ClientControlFrame,
  ServerFrame,
  PauseFrame,
  ResumeFrame,
  EndFrame,
  PingFrame,
  ResumeFromFrame,
  TranscriptSegmentFrame,
  InterimTranscriptFrame,
  AckFrame,
  PongFrame,
  RawServerFrame,
} from './wire'
