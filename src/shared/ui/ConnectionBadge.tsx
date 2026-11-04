import type { ConnectionStatus } from '../transport/status'

const LABEL: Record<ConnectionStatus, { text: string; tone: string }> = {
  connecting: { text: 'Conectando…', tone: 'badge-neutral' },
  open: { text: 'En vivo', tone: 'badge-ok' },
  reconnecting: { text: 'Reconectando…', tone: 'badge-warn' },
  closed: { text: 'Desconectado', tone: 'badge-bad' },
}

export function ConnectionBadge({ status, detail }: { status: ConnectionStatus; detail?: string }) {
  const { text, tone } = LABEL[status]
  return (
    <span className={`badge ${tone}`} role="status" title={detail}>
      <span className="dot" aria-hidden="true" />
      {text}
      {detail ? <span className="muted" style={{ fontWeight: 400 }}>{detail}</span> : null}
    </span>
  )
}
