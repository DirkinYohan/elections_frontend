import { describe, expect, it } from 'vitest'
import type { TallySheet } from '../contracts/messages'
import { normalizeResponse, normalizeStatus } from './ballots'

const sheet: TallySheet = {
  acta: 'E14-110-0001-03', mesa: 1, puesto: 110, municipio: 11, version: 1, jurado: 'jury1',
  ts_cierre: 0, votos: { C1: 1 }, sufragantes: 1, hash_foto: 'x', idem: 'abc',
}

describe('normalizeStatus', () => {
  it('maps the statuses the backend returns today', () => {
    expect(normalizeStatus('ACCEPTED')).toBe('REGISTERED')
    expect(normalizeStatus('SUSPICIOUS_FOR_VERIFICATION')).toBe('DOUBTFUL')
    expect(normalizeStatus('DUPLICATE')).toBe('DUPLICATE')
  })
})

describe('normalizeResponse', () => {
  it('turns 503 into unavailable (not stored)', () => {
    expect(normalizeResponse(503, { status: 'UNAVAILABLE' }, sheet).kind).toBe('unavailable')
  })

  it('turns 429 into rate_limited with a wait', () => {
    const outcome = normalizeResponse(429, { error: 'Rate limit exceeded' }, sheet)
    expect(outcome).toEqual({ kind: 'rate_limited', retryAfterMs: 10_000 })
  })

  it('accepts the current backend body', () => {
    const outcome = normalizeResponse(200, { status: 'ACCEPTED', ballotId: sheet.acta, version: 1 }, sheet)
    expect(outcome.kind === 'answered' && outcome.response.status).toBe('REGISTERED')
  })

  it('treats other 4xx without status as rejected', () => {
    const outcome = normalizeResponse(400, { error: 'bad' }, sheet)
    expect(outcome.kind === 'answered' && outcome.response.status).toBe('REJECTED')
  })
})
