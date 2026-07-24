import type { WsLike } from '../src/stream-client'

type Listener = (event: unknown) => void

/**
 * A fake `WebSocket` satisfying {@link WsLike}, for driving the stream client's
 * transport in unit tests. Records sent frames and exposes drivers to simulate
 * open / message / close from the "server" side.
 */
export class MockWs implements WsLike {
  static instances: MockWs[] = []

  static reset(): void {
    MockWs.instances = []
  }

  /** The most recently constructed instance. */
  static last(): MockWs {
    const ws = MockWs.instances[MockWs.instances.length - 1]
    if (!ws) {
      throw new Error('no MockWs instance created')
    }
    return ws
  }

  readyState = 0
  binaryType = ''
  sent: Array<string | ArrayBuffer> = []
  readonly url: string
  readonly protocols: string[]
  private readonly listeners = new Map<string, Set<Listener>>()

  constructor(url: string, protocols: string[]) {
    this.url = url
    this.protocols = protocols
    MockWs.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    const set = this.listeners.get(type) ?? new Set<Listener>()
    set.add(listener)
    this.listeners.set(type, set)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  send(data: string | ArrayBuffer): void {
    this.sent.push(data)
  }

  close(code = 1000): void {
    this.readyState = 3
    this.emit('close', { code })
  }

  // --- test drivers ---
  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  message(data: unknown): void {
    this.emit('message', {
      data: typeof data === 'string' ? data : JSON.stringify(data),
    })
  }

  /** Simulate a server-initiated close with the given code. */
  serverClose(code: number): void {
    this.readyState = 3
    this.emit('close', { code })
  }

  /** JSON (text) frames the client sent, parsed. */
  jsonSent(): Array<Record<string, unknown>> {
    return this.sent
      .filter((f): f is string => typeof f === 'string')
      .map(f => JSON.parse(f) as Record<string, unknown>)
  }

  /** Binary frames the client sent. */
  binarySent(): ArrayBuffer[] {
    return this.sent.filter((f): f is ArrayBuffer => f instanceof ArrayBuffer)
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event)
    }
  }
}
