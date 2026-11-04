import type { QueueItem } from '../lib/queue'
import { retryNow } from '../store'
import { StatusBadge } from './StatusBadge'

interface Props {
  items: QueueItem[]
  onCorrect: (item: QueueItem) => void
}

export function QueueList({ items, onCorrect }: Props) {
  if (!items.length) {
    return <p className="muted">Todavía no has transmitido actas.</p>
  }
  // Latest version of each acta is the one that can be corrected.
  const latest = new Map<string, number>()
  for (const i of items) latest.set(i.sheet.acta, Math.max(latest.get(i.sheet.acta) ?? 0, i.sheet.version))

  return (
    <ul className="queue">
      {items.map((item) => (
        <li key={item.key} className="card queue-item">
          <div className="queue-head">
            <div>
              <strong className="mono">{item.sheet.acta}</strong>
              <span className="muted"> · versión {item.sheet.version}</span>
              <div className="muted small">
                Mesa {item.sheet.mesa} · puesto {item.sheet.puesto} · {item.sheet.sufragantes} sufragantes
              </div>
            </div>
            <div className="row">
              {item.status === 'queued' && (
                <button className="btn btn-small" type="button" onClick={() => void retryNow(item.key)}>
                  Reintentar ahora
                </button>
              )}
              {latest.get(item.sheet.acta) === item.sheet.version && item.status !== 'queued' && item.status !== 'sending' && (
                <button className="btn btn-small" type="button" onClick={() => onCorrect(item)}>
                  Corregir
                </button>
              )}
            </div>
          </div>
          <StatusBadge item={item} />
          <div className="muted small mono">
            idem {item.sheet.idem} · intentos {item.attempts}
          </div>
        </li>
      ))}
    </ul>
  )
}
