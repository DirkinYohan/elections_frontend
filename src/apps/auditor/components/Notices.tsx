import { useEffect } from 'react'
import type { Notice } from '@shared/verification/reducer'

export function Notices({ notices, onDismiss }: { notices: Notice[]; onDismiss: (id: number) => void }) {
  useEffect(() => {
    if (!notices.length) return
    const oldest = notices[0]
    const timer = setTimeout(() => onDismiss(oldest.id), 7000)
    return () => clearTimeout(timer)
  }, [notices, onDismiss])

  return (
    <div className="notices" role="status" aria-live="polite">
      {notices.map((n) => (
        <div key={n.id} className={`notice notice-${n.tone} notice-toast`}>
          <span>{n.text}</span>
          <button className="btn btn-small" type="button" onClick={() => onDismiss(n.id)} aria-label="Cerrar aviso">
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
