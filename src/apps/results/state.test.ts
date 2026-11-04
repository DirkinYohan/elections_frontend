import { describe, expect, it } from 'vitest'
import type { CorrectionEvent, DeltaEvent, SnapshotEvent } from '@shared/contracts/messages'
import { applyEvent, initialState, rankCandidates } from './state'

const snapshot: SnapshotEvent = {
  type: 'snapshot',
  topic: 'department',
  totals: { votes: { C1: 100, C2: 50, BLANCO: 10 }, tablesReported: 3, tablesTotal: 10 },
  instanceId: 'i-1',
  at: 1000,
}

const delta: DeltaEvent = {
  type: 'delta',
  topic: 'department',
  changes: { votes: { C1: 140 }, tablesReported: 4 },
  at: 2000,
}

describe('applyEvent', () => {
  it('applies a snapshot as the full state', () => {
    const s = applyEvent(initialState('department'), snapshot)
    expect(s.totals?.votes.C1).toBe(100)
    expect(s.instanceId).toBe('i-1')
  })

  it('applies a delta with absolute values', () => {
    const s = applyEvent(applyEvent(initialState('department'), snapshot), delta)
    expect(s.totals?.votes).toEqual({ C1: 140, C2: 50, BLANCO: 10 })
    expect(s.totals?.tablesReported).toBe(4)
  })

  it('is idempotent: the same delta twice gives the same state (replay overlap)', () => {
    const once = applyEvent(applyEvent(initialState('department'), snapshot), delta)
    const twice = applyEvent(once, delta)
    expect(twice.totals).toEqual(once.totals)
    expect(twice.anomalies).toEqual([])
  })

  it('ignores events of another topic', () => {
    const s = applyEvent(initialState('department'), { ...snapshot, topic: 'municipality:11' })
    expect(s.totals).toBeNull()
  })

  it('records a correction with the values that went down', () => {
    const correction: CorrectionEvent = {
      type: 'correction',
      topic: 'department',
      changes: { votes: { C1: 90 } },
      corrections: [{ ballotId: 'E14-110-0001-03', fromVersion: 1, toVersion: 2 }],
      at: 3000,
    }
    const s = applyEvent(applyEvent(initialState('department'), snapshot), correction)
    expect(s.totals?.votes.C1).toBe(90)
    expect(s.corrections[0].decreased).toEqual(['C1'])
    expect(s.anomalies).toEqual([])
  })

  it('flags a decrease that arrives without a correction as an anomaly', () => {
    const bad: DeltaEvent = { ...delta, changes: { votes: { C1: 10 } } }
    const s = applyEvent(applyEvent(initialState('department'), snapshot), bad)
    expect(s.anomalies).toHaveLength(1)
  })
})

describe('rankCandidates', () => {
  it('sorts by votes and computes the share of valid votes', () => {
    const ranked = rankCandidates({ votes: { C1: 30, C2: 60, BLANCO: 10 }, tablesReported: 1, tablesTotal: 1 }, ['C1', 'C2'])
    expect(ranked.map((r) => r.key)).toEqual(['C2', 'C1'])
    expect(ranked[0].pct).toBeCloseTo(60)
  })
})
