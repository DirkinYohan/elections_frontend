import { describe, expect, it } from 'vitest'
import type { TallySheet } from '@shared/contracts/messages'
import { buildActaId, checkAccounting } from './acta'
import { applyOutcome, applyVerification, createItem, isDue, markSending, nextVersion, recoverInterrupted } from './queue'

const sheet: TallySheet = {
  acta: 'E14-176-0042-03', mesa: 42, puesto: 176, municipio: 11, version: 1, jurado: 'jury1',
  ts_cierre: 0, votos: { C1: 10, C2: 5, BLANCO: 1, NULO: 1, NO_MARCADO: 0 }, sufragantes: 17, hash_foto: 'h', idem: 'abc',
}
const fixed = () => 0.5

describe('acta helpers', () => {
  it('builds the acta id with a 4-digit table', () => {
    expect(buildActaId(176, 42)).toBe('E14-176-0042-03')
  })

  it('checks the accounting rule', () => {
    expect(checkAccounting(sheet.votos, 17).ok).toBe(true)
    expect(checkAccounting(sheet.votos, 20)).toMatchObject({ ok: false, difference: -3 })
  })
})

describe('queue state machine', () => {
  it('a new item is due immediately', () => {
    expect(isDue(createItem(sheet, 1000), 1000)).toBe(true)
  })

  it('network error goes back to the queue with backoff and keeps the same idem', () => {
    const item = applyOutcome(markSending(createItem(sheet, 0), 0), { kind: 'network_error', message: 'Sin conexión' }, 1000, fixed)
    expect(item.status).toBe('queued')
    expect(item.sheet.idem).toBe('abc')
    expect(item.nextAttemptAt).toBeGreaterThan(1000)
    expect(isDue(item, 1000)).toBe(false)
  })

  it('503 marks the item as degraded and NOT stored', () => {
    const item = applyOutcome(createItem(sheet, 0), { kind: 'unavailable', message: 'Redis caído' }, 0, fixed)
    expect(item).toMatchObject({ status: 'queued', degraded: true })
  })

  it('429 waits the time the server asks for', () => {
    const item = applyOutcome(createItem(sheet, 0), { kind: 'rate_limited', retryAfterMs: 10_000 }, 0)
    expect(item.nextAttemptAt).toBe(10_000)
  })

  it('DUPLICATE counts as confirmed and keeps the original receipt', () => {
    let item = applyOutcome(createItem(sheet, 0), { kind: 'answered', response: { status: 'REGISTERED', ballotId: sheet.acta, version: 1, receipt: 'R-1' } }, 0)
    item = applyOutcome({ ...item, status: 'queued' }, { kind: 'answered', response: { status: 'DUPLICATE', ballotId: sheet.acta, version: 1 } }, 1)
    expect(item.status).toBe('confirmed')
    expect(item.response?.receipt).toBe('R-1')
  })

  it('DOUBTFUL then verification', () => {
    const doubtful = applyOutcome(createItem(sheet, 0), { kind: 'answered', response: { status: 'DOUBTFUL', ballotId: sheet.acta, version: 1 } }, 0)
    expect(doubtful.status).toBe('doubtful')
    const verified = applyVerification(doubtful, { type: 'ballot_update', ballotId: sheet.acta, version: 1, decision: 'RATIFIED', at: 5 }, 5)
    expect(verified.status).toBe('verified')
    const rejected = applyVerification(doubtful, { type: 'ballot_update', ballotId: sheet.acta, version: 1, decision: 'REJECTED', at: 5 }, 5)
    expect(rejected.status).toBe('rejected')
  })

  it('an item interrupted while sending is queued again (crash between store and confirm)', () => {
    expect(recoverInterrupted(markSending(createItem(sheet, 0), 0), 9).status).toBe('queued')
  })

  it('computes the next version for a correction', () => {
    const items = [createItem(sheet, 0), createItem({ ...sheet, version: 2 }, 0)]
    expect(nextVersion(items, sheet.acta)).toBe(3)
    expect(nextVersion(items, 'E14-1-0001-03')).toBe(1)
  })
})
