/** "E14-<puesto>-<mesa with 4 digits>-<corporation>", e.g. E14-176-0042-03 */
export function buildActaId(puesto: number, mesa: number, corporation = '03'): string {
  return `E14-${puesto}-${String(mesa).padStart(4, '0')}-${corporation}`
}

export function sumVotes(votes: Record<string, number>): number {
  return Object.values(votes).reduce((sum, v) => sum + (Number.isFinite(v) ? v : 0), 0)
}

export interface AccountingCheck {
  sum: number
  voters: number
  ok: boolean
  difference: number
}

/** Accounting rule of the case study: votes + blank + null + unmarked = voters. */
export function checkAccounting(votes: Record<string, number>, voters: number): AccountingCheck {
  const sum = sumVotes(votes)
  return { sum, voters, ok: sum === voters, difference: sum - voters }
}

/** 16 hex chars, generated once per acta + version and stored BEFORE the first send (RF-1). */
export function newIdempotencyKey(): string {
  const bytes = new Uint8Array(8)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export const itemKey = (acta: string, version: number) => `${acta}#${version}`

/** Unix seconds for ts_cierre. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}
