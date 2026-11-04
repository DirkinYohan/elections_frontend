import { describe, expect, it } from 'vitest'
import type { VerificationCase } from '../contracts/messages'
import { initialVerificationState, reduceVerification, sortedCases, type VerificationState } from './reducer'

const item: VerificationCase = {
  ballotId: 'E14-110-0001-03', version: 1, municipio: 11, puesto: 110, mesa: 1, priority: 2,
  reason: 'No cuadra', votos: { C1: 1 }, sufragantes: 2, createdAt: 1,
}

function withMe(): VerificationState {
  let s = reduceVerification(initialVerificationState, { type: 'welcome', auditorId: 'auditor1', name: 'auditor1', role: 'AUDITOR', instanceId: 'i', lockTtlMs: 30000, heartbeatMs: 10000 })
  s = reduceVerification(s, { type: 'queue_snapshot', cases: [item] })
  return s
}

describe('reduceVerification', () => {
  it('stores my lock token only when it is mine', () => {
    const s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 100, since: 1, lockToken: 't1' })
    expect(s.myLock).toEqual({ ballotId: item.ballotId, token: 't1', expiresAt: 100, since: 1 })
    expect(s.cases[item.ballotId].lockedBy).toBe('auditor1')
  })

  it('shows other auditors locks without a token', () => {
    const s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor2', auditorName: 'auditor2', lockExpiresAt: 100, since: 1 })
    expect(s.myLock).toBeNull()
    expect(s.cases[item.ballotId].lockedByName).toBe('auditor2')
  })

  it('drops my lock and explains when it expires', () => {
    let s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 100, since: 1, lockToken: 't1' })
    s = reduceVerification(s, { type: 'case_released', ballotId: item.ballotId, reason: 'expired' })
    expect(s.myLock).toBeNull()
    expect(s.cases[item.ballotId].lockedBy).toBeUndefined()
    expect(s.notices.at(-1)?.tone).toBe('warn')
  })

  it('renews the expiry on a heartbeat-driven case_locked without token', () => {
    let s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 100, since: 1, lockToken: 't1' })
    s = reduceVerification(s, { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 200, since: 1 })
    expect(s.myLock?.expiresAt).toBe(200)
    expect(s.myLock?.token).toBe('t1')
  })

  it('removes resolved cases', () => {
    const s = reduceVerification(withMe(), { type: 'case_resolved', ballotId: item.ballotId, auditorId: 'auditor2', decision: 'RATIFIED' })
    expect(s.cases[item.ballotId]).toBeUndefined()
  })

  it('LOCK_NOT_OWNED clears my lock', () => {
    let s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 100, since: 1, lockToken: 't1' })
    s = reduceVerification(s, { type: 'error', code: 'LOCK_NOT_OWNED', message: 'expiró' })
    expect(s.myLock).toBeNull()
  })

  it('after a reconnection, explains that the lock was lost to someone else', () => {
    let s = reduceVerification(withMe(), { type: 'case_locked', ballotId: item.ballotId, auditorId: 'auditor1', auditorName: 'auditor1', lockExpiresAt: 100, since: 1, lockToken: 't1' })
    s = reduceVerification(s, { type: 'queue_snapshot', cases: [{ ...item, lockedBy: 'auditor2', lockedByName: 'auditor2', lockExpiresAt: 500 }] })
    expect(s.myLock).toBeNull()
    expect(s.notices.at(-1)?.text).toContain('auditor2')
  })

  it('sorts by priority then age', () => {
    const list = sortedCases({ a: { ...item, ballotId: 'a', priority: 1, createdAt: 1 }, b: { ...item, ballotId: 'b', priority: 3, createdAt: 5 }, c: { ...item, ballotId: 'c', priority: 3, createdAt: 2 } })
    expect(list.map((c) => c.ballotId)).toEqual(['c', 'b', 'a'])
  })
})
