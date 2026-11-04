import { describe, expect, it } from 'vitest'
import { backoffDelay } from './backoff'

describe('backoffDelay', () => {
  it('doubles the window on every attempt without jitter', () => {
    const delays = [0, 1, 2, 3].map((attempt) => backoffDelay(attempt, { baseMs: 500, jitter: false }))
    expect(delays).toEqual([500, 1000, 2000, 4000])
  })

  it('never exceeds the cap', () => {
    expect(backoffDelay(20, { baseMs: 500, capMs: 30_000, jitter: false })).toBe(30_000)
  })

  it('with full jitter stays inside [0, window)', () => {
    expect(backoffDelay(3, { baseMs: 500, random: () => 0 })).toBe(0)
    expect(backoffDelay(3, { baseMs: 500, random: () => 0.999 })).toBeLessThan(4000)
  })

  it('spreads clients that retry on the same attempt', () => {
    const delays = Array.from({ length: 1000 }, () => backoffDelay(4, { baseMs: 500 }))
    const distinct = new Set(delays.map((d) => Math.floor(d / 100)))
    // 8000 ms window in 100 ms buckets: retries land in many different buckets.
    expect(distinct.size).toBeGreaterThan(50)
  })
})
