import type { SubmitResponse, SubmitStatus, TallySheet } from '../contracts/messages'
import { readJson, request } from './http'

/** What the send loop needs to know after one attempt. */
export type SubmitOutcome =
  | { kind: 'answered'; response: SubmitResponse }
  /** 503 or explicit UNAVAILABLE: NOT stored, keep it queued. */
  | { kind: 'unavailable'; message: string }
  /** 429: wait at least this long. */
  | { kind: 'rate_limited'; retryAfterMs: number }
  /** Timeout, no network, connection dropped before the answer. The sheet MAY be stored. */
  | { kind: 'network_error'; message: string }

/** Statuses the backend returns today, mapped to the contract (see CONTRACT.md). */
const LEGACY_STATUS: Record<string, SubmitStatus> = {
  ACCEPTED: 'REGISTERED',
  SUSPICIOUS_FOR_VERIFICATION: 'DOUBTFUL',
  SUSPICIOUS: 'DOUBTFUL',
  CORRECTED: 'REGISTERED',
}

const KNOWN: readonly SubmitStatus[] = ['REGISTERED', 'DUPLICATE', 'SUPERSEDED', 'DOUBTFUL', 'REJECTED', 'UNAVAILABLE']

export function normalizeStatus(raw: unknown): SubmitStatus | null {
  if (typeof raw !== 'string') return null
  const upper = raw.toUpperCase()
  if ((KNOWN as readonly string[]).includes(upper)) return upper as SubmitStatus
  return LEGACY_STATUS[upper] ?? null
}

/** Accepts both the contract shape and the current backend shape ({status, ballotId, version, message}). */
export function normalizeResponse(httpStatus: number, body: unknown, sheet: TallySheet): SubmitOutcome {
  const data = (body ?? {}) as Record<string, unknown>
  const status = normalizeStatus(data.status)

  if (httpStatus === 503 || status === 'UNAVAILABLE') {
    return { kind: 'unavailable', message: String(data.message ?? data.reason ?? 'Sistema degradado') }
  }
  if (httpStatus === 429) {
    const seconds = Number(data.retryAfterSeconds ?? data.secondsUntilReset ?? 10)
    return { kind: 'rate_limited', retryAfterMs: Math.max(1, seconds) * 1000 }
  }
  if (httpStatus >= 500) return { kind: 'network_error', message: `Error del servidor (${httpStatus})` }

  const response: SubmitResponse = {
    status: status ?? (httpStatus >= 400 ? 'REJECTED' : 'REGISTERED'),
    ballotId: String(data.ballotId ?? data.acta ?? sheet.acta),
    version: Number(data.version ?? sheet.version),
    receipt: typeof data.receipt === 'string' ? data.receipt : undefined,
    message: String(data.message ?? data.reason ?? data.error ?? ''),
    registeredAt: typeof data.registeredAt === 'number' ? data.registeredAt : undefined,
  }
  return { kind: 'answered', response }
}

/** POST /api/v1/ballots. Never throws: every failure becomes an outcome the queue understands. */
export async function submitBallot(sheet: TallySheet, token: string | undefined, clientId: string): Promise<SubmitOutcome> {
  let response: Response
  try {
    response = await request('/ballots', {
      method: 'POST',
      body: sheet,
      token,
      headers: { 'X-Client-Id': clientId },
      timeoutMs: 15_000,
    })
  } catch (error) {
    const aborted = error instanceof DOMException && error.name === 'AbortError'
    return { kind: 'network_error', message: aborted ? 'Sin respuesta en 15 s' : 'Sin conexión' }
  }
  return normalizeResponse(response.status, await readJson(response), sheet)
}
