import type { Candidate } from '../contracts/messages'

const PALETTE = ['--c1', '--c2', '--c3', '--c4', '--c5']

/** Fixed color per candidate, shared by every app: C1 is always the same color everywhere. */
export function candidateColor(key: string, candidates: readonly Candidate[]): string {
  const index = candidates.findIndex((c) => c.key === key)
  return index >= 0 ? `var(${PALETTE[index % PALETTE.length]})` : 'var(--c-special)'
}

export function candidateLabel(key: string, candidates: readonly Candidate[]): string {
  return candidates.find((c) => c.key === key)?.name ?? key
}

export function formatInt(n: number): string {
  return new Intl.NumberFormat('es-CO').format(n)
}

export function formatPct(value: number, digits = 1): string {
  return `${new Intl.NumberFormat('es-CO', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value)} %`
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return m ? `${m} min ${String(s).padStart(2, '0')} s` : `${s} s`
}
