import type { QueueItem } from './queue'

/** One unambiguous sentence per state (RF-1): the poll worker must know for sure what happened. */
export function describe(item: QueueItem, now: number): { title: string; detail: string; tone: string; icon: string } {
  const wait = Math.max(0, Math.ceil((item.nextAttemptAt - now) / 1000))
  const receipt = item.response?.receipt ? `Recibo ${item.response.receipt}` : ''
  switch (item.status) {
    case 'queued':
      if (item.degraded) return { title: 'Aún NO registrada', detail: `El sistema está degradado. Se reintenta sola en ${wait} s.`, tone: 'badge-bad', icon: '!' }
      if (item.attempts === 0) return { title: 'En cola', detail: 'Se enviará apenas haya conexión.', tone: 'badge-neutral', icon: '…' }
      return { title: 'Sin confirmar todavía', detail: `${item.lastError ?? 'Sin respuesta'}. Reintento en ${wait} s con el mismo identificador.`, tone: 'badge-warn', icon: '↻' }
    case 'sending':
      return { title: 'Enviando…', detail: 'Esperando la confirmación del servidor.', tone: 'badge-info', icon: '↑' }
    case 'confirmed': {
      const status = item.response?.status
      if (status === 'DUPLICATE') return { title: 'Registrada ✓', detail: `Ya estaba registrada desde un envío anterior. ${receipt}`, tone: 'badge-ok', icon: '✓' }
      if (status === 'SUPERSEDED') return { title: 'Registrada ✓', detail: `Ya hay una versión más nueva de esta acta aplicada. ${receipt}`, tone: 'badge-ok', icon: '✓' }
      return { title: 'Registrada ✓', detail: receipt, tone: 'badge-ok', icon: '✓' }
    }
    case 'doubtful':
      return { title: 'En verificación', detail: `${item.response?.message ?? 'No cuadra la regla contable'}. ${receipt}`, tone: 'badge-warn', icon: '?' }
    case 'verified':
      return {
        title: item.verification?.decision === 'CORRECTED' ? 'Verificada: corregida por auditoría' : 'Verificada ✓',
        detail: item.verification?.notes ?? receipt,
        tone: 'badge-ok',
        icon: '✓',
      }
    case 'rejected':
      return {
        title: item.verification ? 'Rechazada en verificación' : 'Rechazada',
        detail: item.verification?.notes ?? item.response?.message ?? '',
        tone: 'badge-bad',
        icon: '✕',
      }
  }
}
