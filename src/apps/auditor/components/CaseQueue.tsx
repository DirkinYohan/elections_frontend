import type { Catalog } from '@shared/contracts/messages'
import { formatDuration } from '@shared/ui/candidates'
import { useNow } from '@shared/ui/useNow'
import { sortedCases, type VerificationState } from '@shared/verification/reducer'
import { municipalityName } from '../lib'

interface Props {
  state: VerificationState
  catalog: Catalog | null
  canTake: boolean
  onTake: (ballotId: string) => void
}

export function CaseQueue({ state, catalog, canTake, onTake }: Props) {
  const now = useNow(1000)
  const cases = sortedCases(state.cases)
  if (!cases.length) return <p className="card muted">No hay actas dudosas pendientes.</p>

  return (
    <ul className="case-list">
      {cases.map((c) => {
        const lockedAlive = c.lockedBy && (c.lockExpiresAt ?? 0) > now
        const mine = lockedAlive && c.lockedBy === state.me?.auditorId
        return (
          <li key={c.ballotId} className={`card case ${lockedAlive ? (mine ? 'mine' : 'locked') : ''}`}>
            <div className="case-head">
              <strong className="mono">{c.ballotId}</strong>
              <span className={`badge ${c.priority >= 4 ? 'badge-bad' : c.priority >= 2 ? 'badge-warn' : 'badge-neutral'}`}>Prioridad {c.priority}</span>
            </div>
            <div className="muted small">
              {municipalityName(catalog, c.municipio)} · puesto {c.puesto} · mesa {c.mesa} · versión {c.version} · hace {formatDuration(now - c.createdAt)}
            </div>
            <div className="small">{c.reason}</div>
            <div className="case-foot">
              {lockedAlive ? (
                <span className={`badge ${mine ? 'badge-info' : 'badge-neutral'}`}>
                  <span aria-hidden="true">🔒</span> {mine ? 'Lo estás revisando' : `En revisión por ${c.lockedByName ?? c.lockedBy}`} · {formatDuration((c.lockExpiresAt ?? now) - now)}
                </span>
              ) : (
                <span className="badge badge-ok">Disponible</span>
              )}
              {!lockedAlive && (
                <button className="btn btn-small btn-primary" type="button" disabled={!canTake} onClick={() => onTake(c.ballotId)}>
                  Tomar caso
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}
