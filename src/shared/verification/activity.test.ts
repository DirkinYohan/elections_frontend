import { describe, expect, it } from 'vitest'
import { ActivityTracker } from './activity'

describe('ActivityTracker', () => {
  it('reports activity once per heartbeat interval', () => {
    const t = new ActivityTracker()
    expect(t.consume()).toBe(false)
    t.mark(10)
    t.mark(20)
    expect(t.consume()).toBe(true)
    expect(t.consume()).toBe(false)
    expect(t.lastActivity).toBe(20)
  })
})
