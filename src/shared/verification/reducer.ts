import type { AuditorPresence, AuditorServerMessage, UserRole, VerificationCase } from '../contracts/messages'

export interface Me {
  auditorId: string
  name: string
  role: UserRole
  instanceId: string
  lockTtlMs: number
  heartbeatMs: number
}

export interface MyLock {
  ballotId: string
  token: string
  expiresAt: number
  since: number
}

export interface Notice {
  id: number
  tone: 'ok' | 'warn' | 'bad' | 'info'
  text: string
}

/** Shared by the auditor console and the coordinator view (same WebSocket, same messages). */
export interface VerificationState {
  me: Me | null
  cases: Record<string, VerificationCase>
  myLock: MyLock | null
  presence: AuditorPresence[]
  notices: Notice[]
}

export const initialVerificationState: VerificationState = { me: null, cases: {}, myLock: null, presence: [], notices: [] }

let noticeSeq = 0
function notice(state: VerificationState, tone: Notice['tone'], text: string): Notice[] {
  return [...state.notices, { id: ++noticeSeq, tone, text }].slice(-4)
}

export function dismissNotice(state: VerificationState, id: number): VerificationState {
  return { ...state, notices: state.notices.filter((n) => n.id !== id) }
}

function withoutLock(c: VerificationCase): VerificationCase {
  const { lockedBy: _a, lockedByName: _b, lockExpiresAt: _c, ...rest } = c
  return rest
}

export function reduceVerification(state: VerificationState, msg: AuditorServerMessage): VerificationState {
  switch (msg.type) {
    case 'welcome':
      return { ...state, me: { auditorId: msg.auditorId, name: msg.name, role: msg.role, instanceId: msg.instanceId, lockTtlMs: msg.lockTtlMs, heartbeatMs: msg.heartbeatMs } }

    case 'queue_snapshot': {
      const cases = Object.fromEntries(msg.cases.map((c) => [c.ballotId, c]))
      // After a reconnection the token arrives in a following case_locked; keep ours while the case is still ours.
      const lost = state.myLock && cases[state.myLock.ballotId]?.lockedBy !== state.me?.auditorId ? state.myLock : null
      if (lost) {
        const owner = cases[lost.ballotId]?.lockedByName
        const text = owner
          ? `Mientras estabas desconectado tu bloqueo expiró y ${lost.ballotId} lo tomó ${owner}.`
          : `Mientras estabas desconectado tu bloqueo de ${lost.ballotId} expiró y el caso volvió a la cola.`
        return { ...state, cases, myLock: null, notices: notice(state, 'bad', text) }
      }
      return { ...state, cases }
    }

    case 'case_added':
      return { ...state, cases: { ...state.cases, [msg.item.ballotId]: msg.item } }

    case 'case_locked': {
      const current = state.cases[msg.ballotId]
      const cases = current
        ? { ...state.cases, [msg.ballotId]: { ...current, lockedBy: msg.auditorId, lockedByName: msg.auditorName, lockExpiresAt: msg.lockExpiresAt } }
        : state.cases
      const mine = msg.auditorId === state.me?.auditorId
      if (mine && msg.lockToken) {
        return { ...state, cases, myLock: { ballotId: msg.ballotId, token: msg.lockToken, expiresAt: msg.lockExpiresAt, since: msg.since } }
      }
      if (state.myLock?.ballotId === msg.ballotId) {
        if (mine) return { ...state, cases, myLock: { ...state.myLock, expiresAt: msg.lockExpiresAt } }
        return { ...state, cases, myLock: null, notices: notice(state, 'bad', `Tu bloqueo de ${msg.ballotId} expiró y el caso lo tomó ${msg.auditorName}.`) }
      }
      return { ...state, cases }
    }

    case 'case_released': {
      const current = state.cases[msg.ballotId]
      const cases = current ? { ...state.cases, [msg.ballotId]: withoutLock(current) } : state.cases
      if (state.myLock?.ballotId === msg.ballotId) {
        const text = msg.reason === 'expired' ? `El caso ${msg.ballotId} volvió a la cola: el bloqueo expiró por inactividad.` : `Devolviste ${msg.ballotId} a la cola.`
        return { ...state, cases, myLock: null, notices: notice(state, msg.reason === 'expired' ? 'warn' : 'info', text) }
      }
      return { ...state, cases }
    }

    case 'case_resolved': {
      const { [msg.ballotId]: _removed, ...cases } = state.cases
      if (state.myLock?.ballotId === msg.ballotId) {
        return { ...state, cases, myLock: null, notices: notice(state, 'ok', `Caso ${msg.ballotId} resuelto (${msg.decision}).`) }
      }
      return { ...state, cases }
    }

    case 'take_rejected':
      return { ...state, notices: notice(state, 'warn', `${msg.ballotId} ya lo está revisando ${msg.lockedBy}.`) }

    case 'presence':
      return { ...state, presence: msg.auditors }

    case 'error': {
      const myLock = msg.code === 'LOCK_NOT_OWNED' ? null : state.myLock
      return { ...state, myLock, notices: notice(state, 'bad', msg.message) }
    }
  }
}

/** Queue order: most urgent first, then oldest first. */
export function sortedCases(cases: Record<string, VerificationCase>): VerificationCase[] {
  return Object.values(cases).sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
}
