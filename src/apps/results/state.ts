import type { CorrectionInfo, PublicEvent, Topic, Totals, TotalsChanges } from '@shared/contracts/messages'

export interface CorrectionLogEntry {
  at: number
  corrections: CorrectionInfo[]
  /** Vote keys (or "tablesReported") whose value went down in this event. */
  decreased: string[]
}

/**
 * Pure state of the public page. The render layer only reads it.
 * Every change produces a new object, so the renderer can compare references cheaply.
 */
export interface ResultsState {
  topic: Topic
  totals: Totals | null
  instanceId?: string
  /** `at` of the last applied event (server time). */
  updatedAt?: number
  corrections: CorrectionLogEntry[]
  /** A value that went down WITHOUT a correction event: should never happen; shown in debug. */
  anomalies: string[]
}

const MAX_LOG = 10

export function initialState(topic: Topic, restored?: Partial<ResultsState>): ResultsState {
  return {
    topic,
    totals: restored?.totals ?? null,
    instanceId: restored?.instanceId,
    updatedAt: restored?.updatedAt,
    corrections: restored?.corrections ?? [],
    anomalies: [],
  }
}

function mergeTotals(base: Totals, changes: TotalsChanges): { totals: Totals; decreased: string[] } {
  const decreased: string[] = []
  const votes = { ...base.votes }
  for (const [key, value] of Object.entries(changes.votes ?? {})) {
    if (value < (votes[key] ?? 0)) decreased.push(key)
    votes[key] = value
  }
  const tablesReported = changes.tablesReported ?? base.tablesReported
  if (tablesReported < base.tablesReported) decreased.push('tablesReported')
  return {
    totals: { votes, tablesReported, tablesTotal: changes.tablesTotal ?? base.tablesTotal },
    decreased,
  }
}

const EMPTY: Totals = { votes: {}, tablesReported: 0, tablesTotal: 0 }

/**
 * Applies one event. Deltas carry ABSOLUTE values, so applying the same event twice
 * leaves the state unchanged (safe against replay overlap after a reconnection).
 */
export function applyEvent(state: ResultsState, event: PublicEvent): ResultsState {
  if (event.topic !== state.topic) return state

  if (event.type === 'snapshot') {
    return {
      ...state,
      totals: { votes: { ...event.totals.votes }, tablesReported: event.totals.tablesReported, tablesTotal: event.totals.tablesTotal },
      instanceId: event.instanceId,
      updatedAt: event.at,
    }
  }

  const { totals, decreased } = mergeTotals(state.totals ?? EMPTY, event.changes)

  if (event.type === 'correction') {
    const entry: CorrectionLogEntry = { at: event.at, corrections: event.corrections, decreased }
    return { ...state, totals, updatedAt: event.at, corrections: [entry, ...state.corrections].slice(0, MAX_LOG) }
  }

  const anomalies = decreased.length
    ? [...state.anomalies, `Bajó sin corrección: ${decreased.join(', ')} (${new Date(event.at).toISOString()})`].slice(-MAX_LOG)
    : state.anomalies
  return { ...state, totals, updatedAt: event.at, anomalies }
}

/** Replaces the totals from a polling response (polling transport only). */
export function applyPolled(state: ResultsState, totals: Totals, at: number): ResultsState {
  return { ...state, totals, updatedAt: at }
}

export interface Ranked {
  key: string
  votes: number
  /** Share of valid votes (candidates + blank). */
  pct: number
}

/** Candidates sorted by votes; percentages over valid votes (candidates + blank vote). */
export function rankCandidates(totals: Totals, candidateKeys: readonly string[]): Ranked[] {
  const valid = candidateKeys.reduce((sum, key) => sum + (totals.votes[key] ?? 0), 0) + (totals.votes.BLANCO ?? 0)
  return candidateKeys
    .map((key) => {
      const votes = totals.votes[key] ?? 0
      return { key, votes, pct: valid ? (votes / valid) * 100 : 0 }
    })
    .sort((a, b) => b.votes - a.votes || a.key.localeCompare(b.key))
}

export function reportedPct(totals: Totals): number {
  return totals.tablesTotal ? (totals.tablesReported / totals.tablesTotal) * 100 : 0
}
