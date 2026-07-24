/**
 * Canonical wire contract for the Scribe streaming worker WebSocket.
 *
 * Single source of truth for the frame types and close codes — a verbatim
 * mirror of the scribe-streaming plan's MASTER shared decisions **11** (close
 * codes) and **12** (message contract). Any drift from MASTER is a bug.
 *
 *   URL:  wss://<gameserver_host>/agent/stream/connect?session_id=...
 *   Auth: Sec-WebSocket-Protocol: "auth, <attach-ticket>"  (the browser sends
 *         this via the WebSocket subprotocol array `["auth", ticket]`).
 *
 *   client → worker:
 *     - binary PCM16 frames (ArrayBuffer)
 *     - text {type:"pause"|"resume"|"end"|"ping"}
 *     - opening text {type:"resume_from", acked_offset_bytes}  (0 on fresh)
 *
 *   worker → client:
 *     - {type:"transcript_segment"|"interim_transcript", ordinal, speaker,
 *        text, final, timestamp}
 *     - {type:"ack", audio_offset_bytes}
 *     - {type:"pong"}
 *     - plus native server protocol pings (the browser auto-replies; nothing
 *       to handle in JS).
 */

/** WS path the worker listens on (the host comes from allocate). */
export const WS_CONNECT_PATH = '/agent/stream/connect'

/** Client → worker control-frame `type` values. */
export const CLIENT_FRAME = {
  pause: 'pause',
  resume: 'resume',
  end: 'end',
  ping: 'ping',
  resumeFrom: 'resume_from',
} as const
export type ClientFrameType = (typeof CLIENT_FRAME)[keyof typeof CLIENT_FRAME]

/** Worker → client message `type` values. */
export const SERVER_MESSAGE = {
  transcriptSegment: 'transcript_segment',
  interimTranscript: 'interim_transcript',
  ack: 'ack',
  pong: 'pong',
} as const
export type ServerMessageType = (typeof SERVER_MESSAGE)[keyof typeof SERVER_MESSAGE]

// --- Close codes (MASTER decision 11) ------------------------------------
export const CLOSE_CODE = {
  /** RFC 6455 clean close — session ended normally. Never reconnect. */
  normal: 1000,
  /** RFC 6455 abnormal closure (no close frame). Reconnect. */
  abnormal: 1006,
  /** Server fatal error. Never reconnect (surface the error). */
  fatal: 1011,
  /** Unclean disconnect / try-again — session stays in-progress. Reconnect. */
  tryAgain: 1012,
  /** App: bad request. Do not reconnect. */
  badRequest: 4000,
  /** App: auth failure. Never reconnect. */
  auth: 4001,
  /** App: session not found / owner mismatch. Do not reconnect. */
  notFound: 4004,
  /** App: session in a terminal state. Never reconnect. */
  terminalState: 4009,
  /** App: worker at capacity. Do not reconnect (allocate handles capacity). */
  atCapacity: 4013,
} as const
export type CloseCode = (typeof CLOSE_CODE)[keyof typeof CLOSE_CODE]

/**
 * Whether an observed close code warrants a resumable reconnect.
 *
 * Per decision 11: reconnect on `1012` (try-again) and abnormal `1006`; never
 * on `1000` (clean) / `4009` (terminal) / `4001` (auth) — and, by extension,
 * the other 4xxx client-error codes.
 */
export function shouldReconnect(code: number): boolean {
  return code === CLOSE_CODE.tryAgain || code === CLOSE_CODE.abnormal
}

/**
 * App-level keepalive interval. The browser `WebSocket` API has NO `ping()`
 * method, so the client sends a JSON `{type:"ping"}` text frame on this
 * interval to reset the ALB (1800s) / Envoy (1830s) idle timers on the
 * browser↔worker leg (decision 5). ~20–30s keeps well under both.
 */
export const KEEPALIVE_INTERVAL_MS = 25_000

// --- Frame type definitions ----------------------------------------------
//
// Typed shapes for the frames on the wire. The client sends `ClientControlFrame`
// text frames (plus binary PCM16); the worker sends `ServerFrame` text frames.

/** client → worker: pause capture (WS stays open). */
export interface PauseFrame {
  type: 'pause'
}
/** client → worker: resume after a pause. */
export interface ResumeFrame {
  type: 'resume'
}
/** client → worker: finalize and end the session. */
export interface EndFrame {
  type: 'end'
}
/** client → worker: app-level keepalive. */
export interface PingFrame {
  type: 'ping'
}
/** client → worker: opening frame declaring the acked byte offset to resume from. */
export interface ResumeFromFrame {
  type: 'resume_from'
  acked_offset_bytes: number
}
export type ClientControlFrame = PauseFrame | ResumeFrame | EndFrame | PingFrame | ResumeFromFrame

/** worker → client: a (usually final) transcript segment. */
export interface TranscriptSegmentFrame {
  type: 'transcript_segment'
  ordinal: number
  speaker: string
  text: string
  final: boolean
  timestamp?: number | null
}
/** worker → client: a partial (interim) transcript segment. */
export interface InterimTranscriptFrame {
  type: 'interim_transcript'
  ordinal: number
  speaker: string
  text: string
  final?: boolean
  timestamp?: number | null
}
/** worker → client: cumulative audio-byte ack. */
export interface AckFrame {
  type: 'ack'
  audio_offset_bytes: number
}
/** worker → client: keepalive reply. */
export interface PongFrame {
  type: 'pong'
}
export type ServerFrame = TranscriptSegmentFrame | InterimTranscriptFrame | AckFrame | PongFrame

/**
 * Permissive shape of a JSON-parsed worker frame before validation. The wire is
 * untrusted, so every field is optional/`unknown` and narrowed by the consumer
 * ({@link normalizeTurn} for transcript frames, the stream client for `ack`).
 */
export interface RawServerFrame {
  type?: string
  ordinal?: unknown
  speaker?: unknown
  text?: unknown
  final?: unknown
  timestamp?: unknown
  audio_offset_bytes?: unknown
}
