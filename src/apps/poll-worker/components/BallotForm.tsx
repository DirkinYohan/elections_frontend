import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { Catalog, Session, TallySheet } from '@shared/contracts/messages'
import { SPECIAL_LABELS } from '@shared/api/catalog'
import { buildActaId, checkAccounting, newIdempotencyKey, nowSeconds } from '../lib/acta'
import { compressPhoto, sha256Hex } from '../lib/photo'
import { nextVersion, type QueueItem } from '../lib/queue'
import { enqueue } from '../store'

interface Props {
  catalog: Catalog
  session: Session
  items: QueueItem[]
  correctionOf: QueueItem | null
  onDone: () => void
}

const SPECIALS = ['BLANCO', 'NULO', 'NO_MARCADO'] as const

function toNumber(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value)
}

export function BallotForm({ catalog, session, items, correctionOf, onDone }: Props) {
  const keys = useMemo(() => [...catalog.candidates.map((c) => c.key), ...SPECIALS], [catalog])
  const base = correctionOf?.sheet
  const [municipio, setMunicipio] = useState(base ? String(base.municipio) : '')
  const [puesto, setPuesto] = useState(base ? String(base.puesto) : '')
  const [mesa, setMesa] = useState(base ? String(base.mesa) : '')
  const [votes, setVotes] = useState<Record<string, string>>(() => Object.fromEntries(keys.map((k) => [k, base ? String(base.votos[k] ?? 0) : ''])))
  const [voters, setVoters] = useState(base ? String(base.sufragantes) : '')
  const [photo, setPhoto] = useState<{ blob: Blob; hash: string; url: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => () => {
    if (photo) URL.revokeObjectURL(photo.url)
  }, [photo])

  const municipality = catalog.municipalities.find((m) => String(m.id) === municipio)
  const station = municipality?.stations.find((s) => String(s.id) === puesto)
  const acta = station && mesa ? buildActaId(station.id, Number(mesa), catalog.corporation) : null
  const version = acta ? nextVersion(items, acta) : 1

  const numericVotes = Object.fromEntries(keys.map((k) => [k, toNumber(votes[k] ?? '')]))
  const allFilled = keys.every((k) => Number.isInteger(numericVotes[k]) && numericVotes[k] >= 0) && Number.isInteger(toNumber(voters))
  const accounting = checkAccounting(numericVotes, toNumber(voters))

  async function onPhoto(file: File | undefined) {
    if (!file) return
    setError(null)
    try {
      const blob = await compressPhoto(file)
      const hash = await sha256Hex(blob)
      setPhoto({ blob, hash, url: URL.createObjectURL(blob) })
    } catch {
      setError('No se pudo leer la foto. Intenta tomarla de nuevo.')
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setError(null)
    if (!acta || !station || !municipality) return setError('Selecciona municipio, puesto y mesa.')
    if (!allFilled) return setError('Completa todos los votos y el número de sufragantes con números enteros (0 si no hay).')
    if (!photo) return setError('Falta la foto del acta.')
    if (!accounting.ok) {
      const go = window.confirm(
        `La suma de votos (${accounting.sum}) no coincide con los sufragantes (${accounting.voters}).\n\n` +
          'Si los números son los del acta física, envíala igual: pasará a verificación humana.\n¿Enviar de todos modos?',
      )
      if (!go) return
    }
    setBusy(true)
    const sheet: TallySheet = {
      acta,
      mesa: Number(mesa),
      puesto: station.id,
      municipio: municipality.id,
      version,
      jurado: session.username,
      ts_cierre: nowSeconds(),
      votos: numericVotes,
      sufragantes: toNumber(voters),
      hash_foto: photo.hash,
      idem: newIdempotencyKey(),
    }
    try {
      await enqueue(sheet, photo.blob)
      onDone()
    } catch {
      setError('No se pudo guardar el acta en el teléfono. Revisa el espacio disponible.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card stack" onSubmit={submit} noValidate>
      <h2>{correctionOf ? `Corregir acta (versión ${version})` : 'Nueva acta'}</h2>

      <div className="grid-3">
        <label className="field">
          <span>Municipio</span>
          <select className="input" value={municipio} disabled={!!correctionOf} onChange={(e) => { setMunicipio(e.target.value); setPuesto(''); setMesa('') }} required>
            <option value="">Selecciona…</option>
            {catalog.municipalities.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Puesto</span>
          <select className="input" value={puesto} disabled={!municipality || !!correctionOf} onChange={(e) => { setPuesto(e.target.value); setMesa('') }} required>
            <option value="">Selecciona…</option>
            {municipality?.stations.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>Mesa</span>
          <select className="input" value={mesa} disabled={!station || !!correctionOf} onChange={(e) => setMesa(e.target.value)} required>
            <option value="">Selecciona…</option>
            {station?.tables.map((t) => <option key={t} value={t}>Mesa {t}</option>)}
          </select>
        </label>
      </div>

      {acta && (
        <p className={`notice ${version > 1 ? 'notice-warn' : 'notice-info'}`} style={{ margin: 0 }}>
          Acta <strong className="mono">{acta}</strong>
          {version > 1 ? ` · ya transmitiste esta mesa: se enviará como corrección (versión ${version}).` : ' · versión 1'}
        </p>
      )}

      <fieldset className="votes">
        <legend>Votos del acta</legend>
        {catalog.candidates.map((c) => (
          <label key={c.key} className="vote-row">
            <span>
              <strong>{c.name}</strong>
              <span className="muted small party">{c.party}</span>
            </span>
            <input className="input num" inputMode="numeric" pattern="[0-9]*" value={votes[c.key] ?? ''} onChange={(e) => setVotes({ ...votes, [c.key]: e.target.value.replace(/\D/g, '') })} aria-label={`Votos de ${c.name}`} />
          </label>
        ))}
        {SPECIALS.map((k) => (
          <label key={k} className="vote-row special">
            <span>{SPECIAL_LABELS[k]}</span>
            <input className="input num" inputMode="numeric" pattern="[0-9]*" value={votes[k] ?? ''} onChange={(e) => setVotes({ ...votes, [k]: e.target.value.replace(/\D/g, '') })} aria-label={SPECIAL_LABELS[k]} />
          </label>
        ))}
        <label className="vote-row total">
          <span><strong>Total de sufragantes</strong></span>
          <input className="input num" inputMode="numeric" pattern="[0-9]*" value={voters} onChange={(e) => setVoters(e.target.value.replace(/\D/g, ''))} aria-label="Total de sufragantes" />
        </label>
      </fieldset>

      {allFilled && (
        <p className={`notice ${accounting.ok ? 'notice-ok' : 'notice-warn'}`} role="status" style={{ margin: 0 }}>
          {accounting.ok
            ? `✓ Cuadra: la suma de votos (${accounting.sum}) es igual a los sufragantes.`
            : `✕ No cuadra: suma ${accounting.sum}, sufragantes ${accounting.voters} (diferencia ${accounting.difference > 0 ? '+' : ''}${accounting.difference}). Revisa el acta.`}
        </p>
      )}

      <div className="field">
        <span>Foto del acta</span>
        <label className="photo-pick">
          <input type="file" accept="image/*" capture="environment" onChange={(e) => void onPhoto(e.target.files?.[0])} />
          {photo ? <img src={photo.url} alt="Vista previa del acta" /> : <span>Tomar o elegir foto</span>}
        </label>
        {photo && <span className="muted small mono">SHA-256 {photo.hash.slice(0, 16)}…</span>}
      </div>

      {error && <p className="notice notice-bad" role="alert" style={{ margin: 0 }}>{error}</p>}

      <div className="row">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Guardar y transmitir'}
        </button>
        {correctionOf && (
          <button className="btn" type="button" onClick={onDone}>
            Cancelar
          </button>
        )}
      </div>
      <p className="muted small" style={{ margin: 0 }}>
        El acta se guarda primero en este teléfono y se transmite sola cuando haya conexión. No necesitas reenviarla.
      </p>
    </form>
  )
}
