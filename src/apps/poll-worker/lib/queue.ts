import type { BallotUpdateMessage, SubmitResponse, TallySheet } from '@shared/contracts/messages'
import type { SubmitOutcome } from '@shared/api/ballots'
import { backoffDelay } from '@shared/transport/backoff'
import { itemKey } from './acta'

/**
 * Explicit state machine of one tally sheet in the offline queue (RT-6, RF-1).
 *
 *   queued ──send──▶ sending ──REGISTERED/DUPLICATE/SUPERSEDED──▶ confirmed
 *     ▲                 │──DOUBTFUL──▶ doubtful ──verification──▶ verified | rejected
 *     │                 │──REJECTED──▶ rejected
 *     └──network error / timeout / 503 / 429──┘   (same idem on every retry)
 */
export type QueueStatus = 'queued' | 'sending' | 'confirmed' | 'doubtful' | 'verified' | 'rejected'

export interface QueueItem {
  key: string
  sheet: TallySheet
  status: QueueStatus
  attempts: number
  nextAttemptAt: number
  /** Why the last attempt did not confirm. */
  lastError?: string
  /** Last failure was the backend saying it is degraded (503): NOT stored yet. */
  degraded?: boolean
  response?: SubmitResponse
  verification?: Pick<BallotUpdateMessage, 'decision' | 'notes' | 'at'>
  createdAt: number
  updatedAt: number
}

const BACKOFF = { baseMs: 1000, capMs: 60_000 }

export function createItem(sheet: TallySheet, now: number): QueueItem {
  return { key: itemKey(sheet.acta, sheet.version), sheet, status: 'queued', attempts: 0, nextAttemptAt: now, createdAt: now, updatedAt: now }
}

export const isDue = (item: QueueItem, now: number) => item.status === 'queued' && item.nextAttemptAt <= now

export function markSending(item: QueueItem, now: number): QueueItem {
  return { ...item, status: 'sending', updatedAt: now }
}

/**
 * An item left in 'sending' means the app died mid-request. We do not know if the server stored it,
 * so it goes back to the queue: the resend carries the same idem and gets DUPLICATE if it was stored.
 */
export function recoverInterrupted(item: QueueItem, now: number): QueueItem {
  return item.status === 'sending' ? { ...item, status: 'queued', nextAttemptAt: now, lastError: 'Envío interrumpido; se reenvía con el mismo identificador', updatedAt: now } : item
}

function retry(item: QueueItem, now: number, lastError: string, degraded: boolean, random?: () => number): QueueItem {
  const attempts = item.attempts + 1
  return {
    ...item,
    status: 'queued',
    attempts,
    degraded,
    lastError,
    nextAttemptAt: now + backoffDelay(attempts - 1, { ...BACKOFF, random }) + 500,
    updatedAt: now,
  }
}

export function applyOutcome(item: QueueItem, outcome: SubmitOutcome, now: number, random?: () => number): QueueItem {
  switch (outcome.kind) {
    case 'network_error':
      return retry(item, now, outcome.message, false, random)
    case 'unavailable':
      return retry(item, now, outcome.message, true, random)
    case 'rate_limited':
      return { ...item, status: 'queued', attempts: item.attempts + 1, degraded: false, lastError: 'Demasiados envíos seguidos; se espera y reintenta', nextAttemptAt: now + outcome.retryAfterMs, updatedAt: now }
    case 'answered': {
      const { response } = outcome
      // A DUPLICATE answer keeps the receipt of the first confirmation if the server did not send it again.
      const merged: SubmitResponse = { ...response, receipt: response.receipt ?? item.response?.receipt }
      const base = { ...item, attempts: item.attempts + 1, response: merged, degraded: false, lastError: undefined, updatedAt: now }
      switch (response.status) {
        case 'REGISTERED':
        case 'DUPLICATE':
        case 'SUPERSEDED':
          return { ...base, status: 'confirmed' }
        case 'DOUBTFUL':
          return { ...base, status: 'doubtful' }
        case 'REJECTED':
          return { ...base, status: 'rejected' }
        case 'UNAVAILABLE':
          return retry(item, now, response.message ?? 'Sistema degradado', true, random)
      }
    }
  }
}

/** Human verification resolved a doubtful sheet (message from /ws/juries). */
export function applyVerification(item: QueueItem, update: BallotUpdateMessage, now: number): QueueItem {
  return {
    ...item,
    status: update.decision === 'REJECTED' ? 'rejected' : 'verified',
    verification: { decision: update.decision, notes: update.notes, at: update.at },
    updatedAt: now,
  }
}

/** Next version for a correction: one more than the highest version already queued for this acta. */
export function nextVersion(items: readonly QueueItem[], acta: string): number {
  return items.filter((i) => i.sheet.acta === acta).reduce((max, i) => Math.max(max, i.sheet.version), 0) + 1
}
