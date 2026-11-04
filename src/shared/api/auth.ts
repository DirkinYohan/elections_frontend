import type { Session, UserRole } from '../contracts/messages'
import { HttpError, getJson } from './http'
import { saveSession } from './session'

const ROLE_LABEL: Record<UserRole, string> = {
  JURY: 'jurado',
  AUDITOR: 'auditor',
  COORDINATOR: 'coordinador',
  PUBLIC: 'público',
}

/** POST /api/v1/auth/login and checks that the account has the role this app needs. */
export async function login(username: string, password: string, requiredRole: UserRole): Promise<Session> {
  let session: Session
  try {
    session = await getJson<Session>('/auth/login', { method: 'POST', body: { username, password } })
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) throw new Error('Usuario o contraseña incorrectos')
    throw new Error('No se pudo contactar el servidor. Revisa tu conexión e inténtalo de nuevo.')
  }
  if (session.role !== requiredRole) {
    throw new Error(`Esta cuenta es de ${ROLE_LABEL[session.role]}; aquí se necesita una cuenta de ${ROLE_LABEL[requiredRole]}.`)
  }
  saveSession(session)
  return session
}
