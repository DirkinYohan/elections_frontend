import type { Catalog, Candidate } from '../contracts/messages'
import { SPECIAL_VOTE_KEYS } from '../contracts/messages'
import { getJson } from './http'

const CACHE_KEY = 'elections.catalog'
let inMemory: Catalog | null = null

/**
 * GET /api/v1/catalog. The catalog does not change during the night, so it is cached
 * in localStorage: the poll-worker app can still build the form offline.
 */
export async function getCatalog(): Promise<Catalog> {
  if (inMemory) return inMemory
  try {
    inMemory = await getJson<Catalog>('/catalog', { timeoutMs: 8000 })
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(inMemory))
    } catch {
      // ignore
    }
    return inMemory
  } catch (error) {
    const cached = readCached()
    if (cached) return (inMemory = cached)
    throw error
  }
}

function readCached(): Catalog | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    return raw ? (JSON.parse(raw) as Catalog) : null
  } catch {
    return null
  }
}

/** Fallback candidate list when the catalog is unreachable and nothing is cached. */
export const FALLBACK_CANDIDATES: Candidate[] = [
  { key: 'C1', name: 'Candidato 1', party: '' },
  { key: 'C2', name: 'Candidato 2', party: '' },
  { key: 'C3', name: 'Candidato 3', party: '' },
]

export const SPECIAL_LABELS: Record<(typeof SPECIAL_VOTE_KEYS)[number], string> = {
  BLANCO: 'Voto en blanco',
  NULO: 'Votos nulos',
  NO_MARCADO: 'No marcados',
}

export function isSpecialKey(key: string): key is (typeof SPECIAL_VOTE_KEYS)[number] {
  return (SPECIAL_VOTE_KEYS as readonly string[]).includes(key)
}
