import { useNow } from '@shared/ui/useNow'
import type { QueueItem } from '../lib/queue'
import { describe } from '../lib/status'

export function StatusBadge({ item }: { item: QueueItem }) {
  const now = useNow()
  const d = describe(item, now)
  return (
    <div className="status">
      <span className={`badge big-badge ${d.tone}`}>
        <span aria-hidden="true">{d.icon}</span> {d.title}
      </span>
      {d.detail && <span className="status-detail">{d.detail}</span>}
    </div>
  )
}
