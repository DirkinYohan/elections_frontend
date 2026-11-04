/**
 * Redis Stream IDs look like "1793577600123-4" (milliseconds-sequence).
 * They must be compared numerically: as strings, "999-0" > "1000-0".
 *
 * Returns a negative number if a < b, 0 if equal, positive if a > b.
 */
export function compareStreamIds(a: string, b: string): number {
  const [aMs, aSeq] = parseStreamId(a)
  const [bMs, bSeq] = parseStreamId(b)
  if (aMs !== bMs) return aMs < bMs ? -1 : 1
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1
  return 0
}

export function isValidStreamId(id: string): boolean {
  return /^\d+(-\d+)?$/.test(id)
}

function parseStreamId(id: string): [bigint, bigint] {
  if (!isValidStreamId(id)) throw new Error(`Invalid stream id: ${id}`)
  const [ms, seq = '0'] = id.split('-')
  return [BigInt(ms), BigInt(seq)]
}
