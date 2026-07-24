import { describe, expect, it } from 'vitest'
import { buildWsUrl } from '../src/ws-url'

describe('buildWsUrl', () => {
  it('builds wss://<host>/agent/stream/connect?session_id=...', () => {
    expect(buildWsUrl('gs-abc.actors.platform.amigo.ai', 'sess-1')).toBe(
      'wss://gs-abc.actors.platform.amigo.ai/agent/stream/connect?session_id=sess-1'
    )
  })

  it('url-encodes the session id', () => {
    expect(buildWsUrl('host', 'a/b c')).toBe('wss://host/agent/stream/connect?session_id=a%2Fb%20c')
  })
})
