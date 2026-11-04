export interface BackoffOptions {
  /** First retry window in ms. */
  baseMs?: number
  /** Upper bound for any single wait in ms. */
  capMs?: number
  /**
   * Full jitter on/off. Keep it on in production; turning it off exists only to
   * produce the "without jitter" chart required by RF-10.
   */
  jitter?: boolean
  /** Injectable for tests. */
  random?: () => number
}

/**
 * Exponential backoff with full jitter: wait a random time in [0, min(cap, base · 2^attempt)).
 *
 * Without jitter, the 50.000 clients of an instance that dies all retry at the same
 * instants (0.5 s, 1 s, 2 s...) and knock down the surviving instances (RF-10).
 * With full jitter those retries spread uniformly over the whole window.
 */
export function backoffDelay(attempt: number, opts: BackoffOptions = {}): number {
  const { baseMs = 500, capMs = 30_000, jitter = true, random = Math.random } = opts
  const window = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt))
  return jitter ? Math.floor(random() * window) : window
}
