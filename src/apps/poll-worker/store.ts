import { create } from 'zustand'
import type { BallotUpdateMessage, Session } from '@shared/contracts/messages'
import { submitBallot } from '@shared/api/ballots'
import { loadSession } from '@shared/api/session'
import { allItems, putItem, putItemWithPhoto } from './lib/db'
import { applyOutcome, applyVerification, createItem, isDue, markSending, recoverInterrupted, type QueueItem } from './lib/queue'
import type { TallySheet } from '@shared/contracts/messages'

interface PollWorkerState {
  session: Session | null
  items: QueueItem[]
  online: boolean
  sending: boolean
  setSession: (session: Session | null) => void
}

export const usePollWorker = create<PollWorkerState>((set) => ({
  session: loadSession('JURY'),
  items: [],
  online: navigator.onLine,
  sending: false,
  setSession: (session) => set({ session }),
}))

function upsert(item: QueueItem): void {
  usePollWorker.setState((s) => {
    const others = s.items.filter((i) => i.key !== item.key)
    return { items: [...others, item].sort((a, b) => b.createdAt - a.createdAt) }
  })
}

async function save(item: QueueItem): Promise<void> {
  upsert(item)
  await putItem(item)
}

/** Loads the queue from IndexedDB; items left in 'sending' by a crash go back to the queue. */
export async function loadQueue(): Promise<void> {
  const now = Date.now()
  const items = await allItems()
  const recovered = items.map((i) => recoverInterrupted(i, now))
  await Promise.all(recovered.filter((r, idx) => r !== items[idx]).map(putItem))
  usePollWorker.setState({ items: recovered.sort((a, b) => b.createdAt - a.createdAt) })
}

/** Stores the sheet (with its idem) and the photo BEFORE sending, then kicks the loop. */
export async function enqueue(sheet: TallySheet, photo: Blob | null): Promise<void> {
  const item = createItem(sheet, Date.now())
  await putItemWithPhoto(item, photo)
  upsert(item)
  void flushQueue()
}

export async function retryNow(key: string): Promise<void> {
  const item = usePollWorker.getState().items.find((i) => i.key === key)
  if (item && item.status === 'queued') await save({ ...item, nextAttemptAt: 0 })
  void flushQueue()
}

let running = false

/** Sends every due item, one at a time. Safe to call from any trigger: re-entrant calls are ignored. */
export async function flushQueue(): Promise<void> {
  if (running) return
  const { session } = usePollWorker.getState()
  if (!session) return
  running = true
  usePollWorker.setState({ sending: true })
  try {
    for (;;) {
      const due = usePollWorker.getState().items.filter((i) => isDue(i, Date.now())).sort((a, b) => a.createdAt - b.createdAt)[0]
      if (!due) break
      await save(markSending(due, Date.now()))
      const outcome = await submitBallot(due.sheet, session.token, session.username)
      await save(applyOutcome(due, outcome, Date.now()))
      if (outcome.kind !== 'answered') break // network trouble: let the backoff decide the next attempt
    }
  } finally {
    running = false
    usePollWorker.setState({ sending: false })
  }
}

export async function onBallotUpdate(update: BallotUpdateMessage): Promise<void> {
  const item = usePollWorker.getState().items.find((i) => i.sheet.acta === update.ballotId && i.sheet.version === update.version)
  if (item) await save(applyVerification(item, update, Date.now()))
}

/** Triggers of the send loop: timer, network back, app visible again. */
export function startSendLoop(): () => void {
  const kick = () => void flushQueue()
  const onOnline = () => {
    usePollWorker.setState({ online: true })
    // A single device reacting to 'online' is fine (unlike 400.000 public browsers).
    for (const item of usePollWorker.getState().items) if (item.status === 'queued') void save({ ...item, nextAttemptAt: 0 })
    kick()
  }
  const onOffline = () => usePollWorker.setState({ online: false })
  const onVisible = () => document.visibilityState === 'visible' && kick()
  const timer = setInterval(kick, 3000)
  window.addEventListener('online', onOnline)
  window.addEventListener('offline', onOffline)
  document.addEventListener('visibilitychange', onVisible)
  kick()
  return () => {
    clearInterval(timer)
    window.removeEventListener('online', onOnline)
    window.removeEventListener('offline', onOffline)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
