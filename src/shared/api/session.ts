import type { Session, UserRole } from '../contracts/messages'

const KEY = 'elections.session'

/** Session lives in sessionStorage: closing the tab logs out, which suits shared devices. */
export function loadSession(role: UserRole): Session | null {
  try {
    const raw = sessionStorage.getItem(`${KEY}.${role}`)
    if (!raw) return null
    const session = JSON.parse(raw) as Session
    return session.expiresAt > Date.now() ? session : null
  } catch {
    return null
  }
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(`${KEY}.${session.role}`, JSON.stringify(session))
  } catch {
    // Storage blocked (private mode): the session lives only in memory.
  }
}

export function clearSession(role: UserRole): void {
  try {
    sessionStorage.removeItem(`${KEY}.${role}`)
  } catch {
    // ignore
  }
}
