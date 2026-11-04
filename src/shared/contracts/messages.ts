/**
 * Message contracts between the frontend and the Spring Boot backend (github.com/DirkinYohan/elections).
 * Keep this file in sync with CONTRACT.md: any change here must be agreed with the backend team.
 *
 * Rules:
 * - Names the backend already defines are kept as they are (/api/v1, `ballotId`, `AggregateDto`,
 *   decisions CORRECTED/REJECTED/RATIFIED, /ws/juries, /ws/verification).
 * - The tally sheet payload keeps the Spanish field names of the case study (section 3.1),
 *   which is also what BallotTransmissionDto maps with @JsonProperty.
 */

export const API_BASE = '/api/v1'

// ---------------------------------------------------------------------------
// Identity · POST /api/v1/auth/login
// ---------------------------------------------------------------------------

export type UserRole = 'JURY' | 'AUDITOR' | 'COORDINATOR' | 'PUBLIC'

export interface LoginRequest {
  username: string
  password: string
}

/** SessionDto */
export interface Session {
  token: string
  username: string
  role: UserRole
  expiresAt: number
}

// ---------------------------------------------------------------------------
// Catalog · GET /api/v1/catalog   (pending in the backend)
// ---------------------------------------------------------------------------

/** Candidate keys: "C1", "C2", ... plus the special keys below. */
export type VoteKey = string
export const SPECIAL_VOTE_KEYS = ['BLANCO', 'NULO', 'NO_MARCADO'] as const

export interface Candidate {
  key: VoteKey
  name: string
  party: string
}

export interface PollingStation {
  id: number
  name: string
  /** Table (mesa) numbers of this station. */
  tables: number[]
}

export interface Municipality {
  id: number
  name: string
  stations: PollingStation[]
}

export interface Catalog {
  department: string
  /** Corporation code of the ballot, e.g. "03". */
  corporation: string
  candidates: Candidate[]
  municipalities: Municipality[]
}

// ---------------------------------------------------------------------------
// Poll workers · POST /api/v1/ballots   (headers: Authorization, X-Client-Id)
// ---------------------------------------------------------------------------

/** Tally sheet (acta). BallotTransmissionDto in the backend. */
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
  /** Idempotency key generated ONCE per acta + version and reused on every resend. */
  idem: string
}

/**
 * Every submission gets an unambiguous answer, resends included (RF-1).
 * - REGISTERED:  stored and added to the totals.              (backend today: ACCEPTED)
 * - DUPLICATE:   already stored before; same receipt as the first time.
 * - SUPERSEDED:  stored, but a newer version is already applied (RF-2).
 * - DOUBTFUL:    stored, failed the accounting rule, sent to verification. (today: SUSPICIOUS_FOR_VERIFICATION)
 * - REJECTED:    invalid payload, not stored.
 * - UNAVAILABLE: backend degraded (e.g. Redis down). NOT stored: the client keeps it queued (RF-10).
 */
export type SubmitStatus = 'REGISTERED' | 'DUPLICATE' | 'SUPERSEDED' | 'DOUBTFUL' | 'REJECTED' | 'UNAVAILABLE'

export interface SubmitResponse {
  status: SubmitStatus
  ballotId: string
  version: number
  /** Receipt id. Identical for every resend of the same acta + version. */
  receipt?: string
  message?: string
  /** Epoch ms when the backend stored it. */
  registeredAt?: number
}

// ---------------------------------------------------------------------------
// Public results · SSE   GET /api/v1/stream?topic=<Topic>&lastEventId=<id>
// ---------------------------------------------------------------------------

/** What a public client watches (RF-5). */
export type Topic = 'department' | `municipality:${number}` | `station:${number}`

export interface Totals {
  /** Accumulated votes per VoteKey (candidates and special keys). */
  votes: Record<VoteKey, number>
  /** Tables (mesas) that already reported in this topic. */
  tablesReported: number
  tablesTotal: number
}

/**
 * `changes` carries the NEW ABSOLUTE values of the fields that changed in the window,
 * never increments: applying the same event twice gives the same state.
 */
export type TotalsChanges = Partial<Totals>

/** Full state of a topic: first connection, new topic, or history gap too old (RF-6). */
export interface SnapshotEvent {
  type: 'snapshot'
  topic: Topic
  totals: Totals
  /** Instance that served the connection (RT-1 / RT-2 demo). */
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
  ballotId: string
  fromVersion: number
  toVersion: number
  reason?: string
}

/** Like a delta, but numbers may go DOWN and the event explains why. */
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

/**
 * AggregateDto returned by GET /api/v1/results/department | /municipality/{id} | /station/{id}.
 * Used by the polling transport (comparison measurements, section 7).
 */
export interface AggregateDto {
  level: 'DEPARTMENT' | 'MUNICIPALITY' | 'POLLING_STATION' | 'POLLING_TABLE'
  identifier: string
  reportedTables: number
  totalTables: number
  reportedPercentage: number
  candidateTotals: Record<VoteKey, number>
}

// ---------------------------------------------------------------------------
// Auditors and coordinator · WebSocket   /ws/verification?token=<token>[&role=coordinator]
// ---------------------------------------------------------------------------

/** VerificationCase, identified by `ballotId` like in the backend. */
export interface VerificationCase {
  ballotId: string
  version: number
  municipio: number
  puesto: number
  mesa: number
  /** Higher number = more urgent. */
  priority: number
  reason: string
  votos: Record<VoteKey, number>
  sufragantes: number
  createdAt: number
  /** Present while an auditor holds the lock. */
  lockedBy?: string
  lockedByName?: string
  lockExpiresAt?: number
}

export interface AuditorPresence {
  auditorId: string
  name: string
  /** Case the auditor is working on, if any. */
  ballotId?: string
  /** When the auditor took the current case ("how long"). */
  caseSince?: number
  connectedAt: number
  lastSeen: number
  instanceId: string
}

export type CaseDecision = 'RATIFIED' | 'CORRECTED' | 'REJECTED'

/** Client → server */
export type AuditorClientMessage =
  | { type: 'take_case'; ballotId: string }
  /** `active` = the auditor interacted since the previous heartbeat. Only active heartbeats renew a lock. */
  | { type: 'heartbeat'; active: boolean }
  | {
      type: 'resolve_case'
      ballotId: string
      lockToken: string
      decision: CaseDecision
      correctedVotes?: Record<VoteKey, number>
      notes?: string
    }
  | { type: 'release_case'; ballotId: string; lockToken: string }

export type ErrorCode = 'LOCK_NOT_OWNED' | 'CASE_NOT_FOUND' | 'ALREADY_HOLDING_CASE' | 'READ_ONLY' | 'BAD_MESSAGE'

/** Server → client */
export type AuditorServerMessage =
  | { type: 'welcome'; auditorId: string; name: string; role: UserRole; instanceId: string; lockTtlMs: number; heartbeatMs: number }
  | { type: 'queue_snapshot'; cases: VerificationCase[] }
  | { type: 'case_added'; item: VerificationCase }
  /** `lockToken` is only sent to the connection that owns the lock. */
  | { type: 'case_locked'; ballotId: string; auditorId: string; auditorName: string; lockExpiresAt: number; since: number; lockToken?: string }
  | { type: 'case_released'; ballotId: string; reason: 'released' | 'expired' }
  | { type: 'case_resolved'; ballotId: string; auditorId: string; decision: CaseDecision }
  | { type: 'take_rejected'; ballotId: string; lockedBy: string }
  | { type: 'presence'; auditors: AuditorPresence[] }
  | { type: 'error'; code: ErrorCode; message: string }

// ---------------------------------------------------------------------------
// Poll workers · WebSocket   /ws/juries?token=<token>   (server → client only)
// ---------------------------------------------------------------------------

/** Sent when human verification resolves a doubtful sheet of this poll worker. */
export interface BallotUpdateMessage {
  type: 'ballot_update'
  ballotId: string
  version: number
  decision: CaseDecision
  notes?: string
  at: number
}

// ---------------------------------------------------------------------------
// Operations · GET /api/v1/metrics   (pending in the backend; RT-7)
// ---------------------------------------------------------------------------

export interface InstanceMetrics {
  instanceId: string
  sseConnections: number
  wsConnections: number
  messagesPerSecond: number
  eventLoopLagMs: number
  memoryPerConnectionBytes: number
  ballotsPerMinute: number
  publishLatencyMs: number
  reconnectsPerSecond: number
}

export interface MetricsSample extends Omit<InstanceMetrics, 'instanceId'> {
  t: number
}

export interface MetricsResponse {
  instances: InstanceMetrics[]
  /** Last samples, one per second, summed across instances. */
  history: MetricsSample[]
}

/** WebSocket close codes agreed with the backend (4000–4999 are application codes). */
export const WsCloseCode = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  /** Server overloaded or client too slow (RF-9): reconnect with jitter. */
  RECONNECT: 4000,
  /** Missing or invalid token, or wrong role: do not reconnect. */
  UNAUTHORIZED: 4401,
} as const
