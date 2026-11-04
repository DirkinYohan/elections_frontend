/**
 * Detects real activity of the auditor between heartbeats (RF-7).
 * An open tab is NOT activity: only input events are. So an auditor who goes to lunch
 * with the case open stops renewing the lock and the case returns to the queue.
 */
export class ActivityTracker {
  private active = false
  private lastActivityAt = 0

  mark(now = Date.now()): void {
    this.active = true
    this.lastActivityAt = now
  }

  /** Returns whether there was activity since the previous call, and resets the flag. */
  consume(): boolean {
    const was = this.active
    this.active = false
    return was
  }

  get lastActivity(): number {
    return this.lastActivityAt
  }
}

const EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'input'] as const

export function attachActivity(tracker: ActivityTracker, target: Window = window): () => void {
  const onEvent = () => tracker.mark()
  for (const e of EVENTS) target.addEventListener(e, onEvent, { passive: true })
  return () => {
    for (const e of EVENTS) target.removeEventListener(e, onEvent)
  }
}
