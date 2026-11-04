import { useEffect, useState } from 'react'
import type { Catalog, Session } from '@shared/contracts/messages'
import { getCatalog } from '@shared/api/catalog'
import { clearSession, loadSession } from '@shared/api/session'
import { ConnectionBadge } from '@shared/ui/ConnectionBadge'
import { Login } from '@shared/ui/Login'
import { useVerification } from '@shared/verification/useVerification'
import { CasePanel } from './components/CasePanel'
import { CaseQueue } from './components/CaseQueue'
import { Notices } from './components/Notices'

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession('AUDITOR'))
  if (!session) {
    return <Login title="Consola de verificación" subtitle="Ingreso de auditores" role="AUDITOR" demoUsers={['auditor1', 'auditor2']} onLogin={setSession} />
  }
  return (
    <Console
      session={session}
      onLogout={() => {
        clearSession('AUDITOR')
        setSession(null)
      }}
    />
  )
}

function Console({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { state, status, statusDetail, send, dismiss } = useVerification(session, 'auditor', onLogout)
  const [catalog, setCatalog] = useState<Catalog | null>(null)

  useEffect(() => {
    getCatalog().then(setCatalog).catch(() => setCatalog(null))
  }, [])

  const myCase = state.myLock ? state.cases[state.myLock.ballotId] : undefined
  const queueSize = Object.keys(state.cases).length

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <strong>Consola de verificación</strong>
          <small>
            {session.username}
            {state.me ? ` · servidor ${state.me.instanceId}` : ''}
          </small>
        </div>
        <div className="row">
          <ConnectionBadge status={status} detail={statusDetail} />
          <button className="btn btn-small" type="button" onClick={onLogout}>Salir</button>
        </div>
      </header>
      <Notices notices={state.notices} onDismiss={dismiss} />
      <main className="app-main console">
        <section className="stack" aria-labelledby="queue-title">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="queue-title">Cola de actas dudosas</h2>
            <span className="badge badge-neutral num">{queueSize} en cola</span>
          </div>
          <CaseQueue state={state} catalog={catalog} onTake={(ballotId) => send({ type: 'take_case', ballotId })} canTake={status === 'open' && !state.myLock} />
          <PresenceList state={state} />
        </section>
        <section aria-label="Caso en revisión">
          {myCase && state.myLock ? (
            <CasePanel key={myCase.ballotId} item={myCase} lock={state.myLock} catalog={catalog} lockTtlMs={state.me?.lockTtlMs ?? 30_000} connected={status === 'open'} send={send} />
          ) : (
            <div className="card empty">
              <h2>Ningún caso tomado</h2>
              <p className="muted">
                Toma un caso de la cola. Mientras trabajas, el bloqueo se renueva solo. Si dejas de interactuar, cierras la pestaña o pierdes la conexión,
                el caso vuelve a la cola automáticamente para que otro auditor lo atienda.
              </p>
            </div>
          )}
        </section>
      </main>
    </>
  )
}

function PresenceList({ state }: { state: ReturnType<typeof useVerification>['state'] }) {
  return (
    <details className="card presence">
      <summary>
        Auditores conectados <span className="badge badge-neutral num">{state.presence.length}</span>
      </summary>
      <ul>
        {state.presence.map((p) => (
          <li key={p.auditorId}>
            <strong>{p.name}</strong>
            <span className="muted"> · {p.ballotId ? `revisando ${p.ballotId}` : 'disponible'}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
