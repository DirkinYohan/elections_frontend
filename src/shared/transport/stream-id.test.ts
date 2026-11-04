import { describe, expect, it } from 'vitest'
import { compareStreamIds, isValidStreamId } from './stream-id'

describe('compareStreamIds', () => {
  it('compares milliseconds numerically, not as text', () => {
    expect(compareStreamIds('999-0', '1000-0')).toBeLessThan(0)
  })

  it('breaks ties with the sequence', () => {
    expect(compareStreamIds('1000-2', '1000-10')).toBeLessThan(0)
    expect(compareStreamIds('1000-10', '1000-2')).toBeGreaterThan(0)
  })

  it('treats a missing sequence as 0', () => {
    expect(compareStreamIds('1000', '1000-0')).toBe(0)
  })

  it('rejects malformed ids', () => {
    expect(isValidStreamId('abc')).toBe(false)
    expect(() => compareStreamIds('abc', '1-0')).toThrow()
  })
})
