import { describe, expect, it } from 'vitest'
import { CLIENT_FRAME, CLOSE_CODE, SERVER_MESSAGE, shouldReconnect } from '../src/wire'

describe('wire constants', () => {
  it('mirrors the decision-12 client frame types', () => {
    expect(CLIENT_FRAME).toEqual({
      pause: 'pause',
      resume: 'resume',
      end: 'end',
      ping: 'ping',
      resumeFrom: 'resume_from',
    })
  })

  it('mirrors the decision-12 server message types', () => {
    expect(SERVER_MESSAGE).toEqual({
      transcriptSegment: 'transcript_segment',
      interimTranscript: 'interim_transcript',
      ack: 'ack',
      pong: 'pong',
    })
  })

  it('mirrors the decision-11 close codes', () => {
    expect(CLOSE_CODE.normal).toBe(1000)
    expect(CLOSE_CODE.abnormal).toBe(1006)
    expect(CLOSE_CODE.fatal).toBe(1011)
    expect(CLOSE_CODE.tryAgain).toBe(1012)
    expect(CLOSE_CODE.badRequest).toBe(4000)
    expect(CLOSE_CODE.auth).toBe(4001)
    expect(CLOSE_CODE.notFound).toBe(4004)
    expect(CLOSE_CODE.terminalState).toBe(4009)
    expect(CLOSE_CODE.atCapacity).toBe(4013)
  })
})

describe('shouldReconnect', () => {
  it('reconnects only on 1012 and 1006', () => {
    expect(shouldReconnect(CLOSE_CODE.tryAgain)).toBe(true)
    expect(shouldReconnect(CLOSE_CODE.abnormal)).toBe(true)
  })

  it('never reconnects on clean / auth / terminal / other client-error codes', () => {
    expect(shouldReconnect(CLOSE_CODE.normal)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.auth)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.terminalState)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.fatal)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.badRequest)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.notFound)).toBe(false)
    expect(shouldReconnect(CLOSE_CODE.atCapacity)).toBe(false)
  })
})
