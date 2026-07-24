import { WS_CONNECT_PATH } from './wire'

/**
 * Build the streaming worker WebSocket URL.
 *
 * `wss://<host>/agent/stream/connect?session_id=...` — `host` is the
 * `<gameserver_name>.<scribe-actors-domain>` returned by the allocate endpoint
 * (never hardcoded); `sessionId` is the platform session id the socket attaches
 * to (and the auth ticket is bound to).
 */
export function buildWsUrl(host: string, sessionId: string): string {
  return `wss://${host}${WS_CONNECT_PATH}?session_id=${encodeURIComponent(sessionId)}`
}
