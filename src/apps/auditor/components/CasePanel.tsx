import { useState } from 'react'
import type { AuditorClientMessage, CaseDecision, Catalog, VerificationCase } from '@shared/contracts/messages'
import { SPECIAL_LABELS, isSpecialKey } from '@shared/api/catalog'
import { candidateLabel, formatDuration } from '@shared/ui/candidates'
import { useNow } from '@shared/ui/useNow'
import type { MyLock } from '@shared/verification/reducer'
import { municipalityName } from '../lib'

interface Props {
  item: VerificationCase
  lock: MyLock
  catalog: Catalog | null
  lockTtlMs: number
  connected: boolean
  send: (msg: AuditorClientMessage) => boolean
}

const WARN_BELOW_MS = 15_000

export function CasePanel({ item, lock, catalog, lockTtlMs, connected, send }: Props) {
  const now = useNow(500)
  const [votes, setVotes] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(item.votos).map(([k, v]) => [k, String(v)])))
  const [notes, setNotes] = useState('')
  const remaining = Math.max(0, lock.expiresAt - now)
  const expired = remaining === 0
  const candidates = catalog?.candidates ?? []

  const corrected = Object.fromEntries(Object.entries(votes).map(([k, v]) => [k, Number(v) || 0]))
  const changed = Object.entries(corrected).some(([k, v]) => v !== item.votos[k])
  const originalSum = Object.values(item.votos).reduce((a, b) => a + b, 0)
  const correctedSum = Object.values(corrected).reduce((a, b) => a + b, 0)

  function resolve(decision: CaseDecision) {
    send({
      type: 'resolve_case',
      ballotId: item.ballotId,
      lockToken: lock.token,
      decision,
      ...(decision === 'CORRECTED' ? { correctedVotes: corrected } : {}),
      ...(notes.trim() ? { notes: notes.trim() } : {}),
    })
  }

  const label = (key: string) => (isSpecialKey(key) ? SPECIAL_LABELS[key] : candidateLabel(key, candidates))

  return (
    <article className="card stack case-panel">
      <header className="stack" style={{ gap: 6 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 className="mono">{item.ballotId}</h2>
          <span className="badge badge-info">Versión {item.version}</span>
        </div>
        <span className="muted small">
          {municipalityName(catalog, item.municipio)} · puesto {item.puesto} · mesa {item.mesa} · trabajando hace {formatDuration(now - lock.since)}
        </span>
        <p className="notice notice-warn" style={{ margin: 0 }}>{item.reason}</p>
      </header>

      <div className="lock-meter" aria-live="off">
        <div className="lock-bar">
          <div className="lock-fill" style={{ transform: `scaleX(${Math.min(1, remaining / lockTtlMs)})` }} />
        </div>
        <span className="small num">Bloqueo: {expired ? 'expirado' : formatDuration(remaining)}</span>
      </div>
      {!expired && remaining < WARN_BELOW_MS && (
        <p className="notice notice-warn" role="alert" style={{ margin: 0 }}>
          Sin actividad reciente: el caso volverá a la cola en {Math.ceil(remaining / 1000)} s. Mueve el mouse o escribe para conservarlo.
        </p>
      )}
      {expired && (
        <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>
          Tu bloqueo expiró. El caso volvió a la cola y ya no puedes resolverlo.
        </p>
      )}

      <table className="votes-table">
        <thead>
          <tr>
            <th scope="col">Opción</th>
            <th scope="col" className="num">Acta</th>
            <th scope="col" className="num">Corrección</th>
          </tr>
        </thead>
        <tbody>
          {Object.keys(item.votos).map((key) => (
            <tr key={key}>
              <th scope="row">{label(key)}</th>
              <td className="num">{item.votos[key]}</td>
              <td>
                <input className="input num" inputMode="numeric" aria-label={`Corrección de ${label(key)}`} value={votes[key] ?? ''} onChange={(e) => setVotes({ ...votes, [key]: e.target.value.replace(/\D/g, '') })} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Suma</th>
            <td className="num">{originalSum}</td>
            <td className="num">{correctedSum}</td>
          </tr>
          <tr>
            <th scope="row">Sufragantes</th>
            <td className="num" colSpan={2}>{item.sufragantes}</td>
          </tr>
        </tfoot>
      </table>

      <label className="field">
        <span>Notas de la verificación</span>
        <textarea className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Qué revisaste en la foto del acta" />
      </label>

      <div className="decision-grid">
        <button className="btn btn-primary" type="button" disabled={expired || !connected} onClick={() => resolve('RATIFIED')}>
          Ratificar como está
        </button>
        <button className="btn btn-primary" type="button" disabled={expired || !connected || !changed} onClick={() => resolve('CORRECTED')} title={changed ? '' : 'Edita algún valor para corregir'}>
          Guardar corrección
        </button>
        <button className="btn btn-danger" type="button" disabled={expired || !connected} onClick={() => resolve('REJECTED')}>
          Rechazar acta
        </button>
        <button className="btn" type="button" disabled={expired || !connected} onClick={() => send({ type: 'release_case', ballotId: item.ballotId, lockToken: lock.token })}>
          Devolver a la cola
        </button>
      </div>
      {!connected && <p className="notice notice-warn" style={{ margin: 0 }}>Sin conexión con el servidor. Se reconecta solo; si tarda más que el bloqueo, el caso vuelve a la cola.</p>}
    </article>
  )
}
