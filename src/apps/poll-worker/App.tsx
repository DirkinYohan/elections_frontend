import { useEffect, useState } from 'react'
import type { BallotUpdateMessage, Catalog } from '@shared/contracts/messages'
import { getCatalog } from '@shared/api/catalog'
import { wsUrl } from '@shared/api/http'
import { clearSession } from '@shared/api/session'
import { WsClient } from '@shared/transport/ws-client'
import { Login } from '@shared/ui/Login'
import { BallotForm } from './components/BallotForm'
import { QueueList } from './components/QueueList'
import type { QueueItem } from './lib/queue'
import { loadQueue, onBallotUpdate, startSendLoop, usePollWorker } from './store'

export function App() {
  const session = usePollWorker((s) => s.session)
  const setSession = usePollWorker((s) => s.setSession)

  if (!session) {
    return <Login title="Transmisión de actas" subtitle="Ingreso de jurados de votación" role="JURY" demoUsers={['jury1', 'jury2']} onLogin={setSession} />
  }
  return <Workspace />
}

function Workspace() {
  const session = usePollWorker((s) => s.session)!
  const items = usePollWorker((s) => s.items)
  const online = usePollWorker((s) => s.online)
  const setSession = usePollWorker((s) => s.setSession)
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [catalogError, setCatalogError] = useState(false)
  const [tab, setTab] = useState<'form' | 'list'>('form')
  const [correctionOf, setCorrectionOf] = useState<QueueItem | null>(null)
  const [formKey, setFormKey] = useState(0)

  useEffect(() => {
    getCatalog().then(setCatalog).catch(() => setCatalogError(true))
    let stop = () => {}
    void loadQueue().then(() => {
      stop = startSendLoop()
    })
    // Verification results arrive by WebSocket; if it fails, nothing else breaks.
    const ws = new WsClient<BallotUpdateMessage, never>({
      url: wsUrl('/ws/juries', { token: session.token }),
      onMessage: (msg) => {
        if (msg.type === 'ballot_update') void onBallotUpdate(msg)
      },
      fatalCodes: [4401],
      backoff: { baseMs: 2000, capMs: 60_000 },
    })
    ws.start()
    return () => {
      stop()
      ws.stop()
    }
  }, [session.token])

  const pending = items.filter((i) => i.status === 'queued' || i.status === 'sending').length

  function logout() {
    if (pending && !window.confirm(`Tienes ${pending} acta(s) sin confirmar. Quedan guardadas y se enviarán cuando vuelvas a ingresar. ¿Salir?`)) return
    clearSession('JURY')
    setSession(null)
  }

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <strong>Transmisión de actas</strong>
          <small>Jurado {session.username}</small>
        </div>
        <div className="row">
          <span className={`badge ${online ? 'badge-ok' : 'badge-warn'}`} role="status">
            <span className="dot" aria-hidden="true" /> {online ? 'Con red' : 'Sin red: las actas quedan en cola'}
          </span>
          <button className="btn btn-small" type="button" onClick={logout}>Salir</button>
        </div>
      </header>
      <nav className="tabs" aria-label="Secciones">
        <button type="button" className={tab === 'form' ? 'tab active' : 'tab'} aria-current={tab === 'form'} onClick={() => setTab('form')}>
          {correctionOf ? 'Corrección' : 'Nueva acta'}
        </button>
        <button type="button" className={tab === 'list' ? 'tab active' : 'tab'} aria-current={tab === 'list'} onClick={() => setTab('list')}>
          Mis actas {pending ? <span className="badge badge-warn">{pending} pendientes</span> : null}
        </button>
      </nav>
      <main className="app-main narrow">
        {tab === 'form' &&
          (catalog ? (
            <BallotForm
              key={`${formKey}-${correctionOf?.key ?? 'new'}`}
              catalog={catalog}
              session={session}
              items={items}
              correctionOf={correctionOf}
              onDone={() => {
                setCorrectionOf(null)
                setFormKey((k) => k + 1)
                setTab('list')
              }}
            />
          ) : (
            <p className={catalogError ? 'notice notice-bad' : 'muted'}>
              {catalogError ? 'No se pudo cargar el catálogo de mesas. Conéctate una vez para descargarlo.' : 'Cargando catálogo…'}
            </p>
          ))}
        {tab === 'list' && (
          <QueueList
            items={items}
            onCorrect={(item) => {
              setCorrectionOf(item)
              setTab('form')
            }}
          />
        )}
      </main>
    </>
  )
}
