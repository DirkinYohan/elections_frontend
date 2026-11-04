/**
 * Message contracts between the frontend and the Spring Boot backend.
 * Keep this file in sync with CONTRACT.md: any change here must be agreed with the backend team.
 *
 * The tally sheet payload keeps the Spanish field names defined in the case study (section 3.1).
 * Every other message uses English names.
 */

// ---------------------------------------------------------------------------
// Poll workers (jurados) · HTTP
// ---------------------------------------------------------------------------

/** Candidate keys: "C1", "C2", ... plus "BLANCO", "NULO" and "NO_MARCADO". */
export type VoteKey = string

/** Tally sheet (acta) sent by a poll worker. POST /api/actas */
export interface TallySheet {
  /** "E14-176-0042-03" → puesto-mesa-corporación */
  acta: string
  mesa: number
  puesto: number
  municipio: number
  /** 1 for the first submission, 2, 3... when the sheet is corrected. */
  version: number
  jurado: string
  /** Unix seconds when the table closed. */
  ts_cierre: number
  votos: Record<VoteKey, number>
  sufragantes: number
  hash_foto: string
  /** Idempotency key generated ONCE by the client and reused on every resend. */
  idem: string
}

/**
 * Every submission gets an unambiguous answer, resends included (RF-1).
 * - REGISTERED:  stored and added to the totals.
 * - DUPLICATE:   already stored before; same receipt as the first time.
 * - SUPERSEDED:  stored, but a newer version of this sheet is already applied (RF-2).
 * - DOUBTFUL:    stored, failed the accounting rule, sent to human verification.
 * - REJECTED:    invalid payload, not stored.
 * - UNAVAILABLE: backend degraded (e.g. Redis down). NOT stored: the client must retry (RF-10).
 */
export type SubmitStatus =
  | 'REGISTERED'
  | 'DUPLICATE'
  | 'SUPERSEDED'
  | 'DOUBTFUL'
  | 'REJECTED'
  | 'UNAVAILABLE'

export interface SubmitResponse {
  status: SubmitStatus
  acta: string
  version: number
  /** Receipt id. Identical for every resend of the same acta + version. */
  receipt?: string
  reason?: string
  /** Epoch ms when the backend stored it. */
  registeredAt?: number
}

// ---------------------------------------------------------------------------
// Public results · SSE   GET /api/stream?topic=<Topic>&lastEventId=<id>
// ---------------------------------------------------------------------------

/** What a public client watches (RF-5). */
export type Topic = 'department' | `municipality:${number}` | `station:${number}`

export interface Totals {
  /** Accumulated votes per VoteKey. */
  votes: Record<VoteKey, number>
  /** Tables (mesas) that already reported in this topic. */
  tablesReported: number
  tablesTotal: number
}

/**
 * `changes` carries the NEW ABSOLUTE values of the fields that changed in the window,
 * never increments. Applying the same event twice gives the same state, so a replay
 * overlap after a reconnection cannot double count.
 */
export type TotalsChanges = Partial<Totals>

/** Full state of a topic. Sent on first connection or when the history gap is too old (RF-6). */
export interface SnapshotEvent {
  type: 'snapshot'
  topic: Topic
  totals: Totals
  /** Instance that served the connection (RT-1 / RT-2 verification). */
  instanceId: string
  at: number
}

/** Aggregated change of one time window (RF-4). */
export interface DeltaEvent {
  type: 'delta'
  topic: Topic
  changes: TotalsChanges
  at: number
}

export interface CorrectionInfo {
  acta: string
  fromVersion: number
  toVersion: number
  reason?: string
}

/** Same as a delta, but some numbers may go DOWN and the event explains why. */
export interface CorrectionEvent {
  type: 'correction'
  topic: Topic
  changes: TotalsChanges
  corrections: CorrectionInfo[]
  at: number
}

export type PublicEvent = SnapshotEvent | DeltaEvent | CorrectionEvent
export type PublicEventType = PublicEvent['type']
export const PUBLIC_EVENT_TYPES: readonly PublicEventType[] = ['snapshot', 'delta', 'correction']

// ---------------------------------------------------------------------------
// Auditors · WebSocket   /ws/auditor?name=<name>
// ---------------------------------------------------------------------------

export interface DoubtfulCase {
  caseId: string
  acta: string
  municipio: number
  /** Higher number = more urgent. */
  priority: number
  reason: string
  createdAt: number
  /** Present while an auditor holds the lock. */
  lockedBy?: string
  lockExpiresAt?: number
}

export interface AuditorPresence {
  auditorId: string
  name: string
  /** Case the auditor is working on, if any. */
  caseId?: string
  /** When the auditor took the current case (to show "how long"). */
  caseSince?: number
  lastSeen: number
  instanceId: string
}

export type CaseDecision = 'APPROVE' | 'REJECT'

/** Client → server */
export type AuditorClientMessage =
  | { type: 'take_case'; caseId: string }
  /** `active` = the auditor interacted since the previous heartbeat. Only active heartbeats renew a lock. */
  | { type: 'heartbeat'; active: boolean }
  | { type: 'resolve_case'; caseId: string; lockToken: string; decision: CaseDecision; notes?: string }
  | { type: 'release_case'; caseId: string; lockToken: string }

/** Server → client */
export type AuditorServerMessage =
  | { type: 'welcome'; auditorId: string; instanceId: string; lockTtlMs: number }
  | { type: 'queue_snapshot'; cases: DoubtfulCase[] }
  | { type: 'case_added'; item: DoubtfulCase }
  /** `lockToken` is only sent to the owner of the lock. */
  | { type: 'case_locked'; caseId: string; auditorId: string; lockExpiresAt: number; lockToken?: string }
  | { type: 'case_released'; caseId: string; reason: 'released' | 'expired' }
  | { type: 'case_resolved'; caseId: string; auditorId: string; decision: CaseDecision }
  | { type: 'take_rejected'; caseId: string; lockedBy: string }
  | { type: 'presence'; auditors: AuditorPresence[] }
  | {
      type: 'error'
      code: 'LOCK_NOT_OWNED' | 'CASE_NOT_FOUND' | 'ALREADY_HOLDING_CASE' | 'BAD_MESSAGE'
      message: string
    }

/** WebSocket close codes agreed with the backend (4000–4999 are application codes). */
export const WsCloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** Server overloaded or client too slow (RF-9): reconnect with jitter. */
  RECONNECT: 4000,
  /** Do not reconnect. */
  UNAUTHORIZED: 4401,
} as const
