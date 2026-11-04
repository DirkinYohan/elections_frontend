import { useEffect, useState } from 'react'
import type { MetricsResponse, MetricsSample, Session } from '@shared/contracts/messages'
import { getMetrics, getMockState, mockControls, type MockState } from '@shared/api/metrics'
import { clearSession, loadSession } from '@shared/api/session'
import { formatDuration, formatInt } from '@shared/ui/candidates'
import { ConnectionBadge } from '@shared/ui/ConnectionBadge'
import { Login } from '@shared/ui/Login'
import { useNow } from '@shared/ui/useNow'
import { useVerification } from '@shared/verification/useVerification'
import { Sparkline } from './components/Sparkline'

export function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession('COORDINATOR'))
  if (!session) {
    return <Login title="Operación de la jornada" subtitle="Ingreso del coordinador" role="COORDINATOR" demoUsers={['coordinator1']} onLogin={setSession} />
  }
  return (
    <Dashboard
      session={session}
      onLogout={() => {
        clearSession('COORDINATOR')
        setSession(null)
      }}
    />
  )
}

type MetricKey = Exclude<keyof MetricsSample, 't'>

const KPIS: { key: MetricKey; label: string; unit: string; hint: string }[] = [
  { key: 'sseConnections', label: 'Conexiones SSE', unit: '', hint: 'Público conectado' },
  { key: 'wsConnections', label: 'Conexiones WebSocket', unit: '', hint: 'Auditores y jurados' },
  { key: 'messagesPerSecond', label: 'Mensajes emitidos', unit: '/s', hint: 'Fan-out real tras agregar por ventana' },
  { key: 'eventLoopLagMs', label: 'Retraso del Event Loop (p99)', unit: ' ms', hint: 'Debe mantenerse acotado en el pico (RF-4)' },
  { key: 'memoryPerConnectionBytes', label: 'Memoria por conexión', unit: ' B', hint: '(RSS − RSS sin conexiones) / conexiones' },
  { key: 'ballotsPerMinute', label: 'Actas por minuto', unit: '', hint: 'Recepción de los jurados' },
  { key: 'publishLatencyMs', label: 'Recepción → publicación', unit: ' ms', hint: 'Desde que entra el acta hasta que sale al público' },
  { key: 'reconnectsPerSecond', label: 'Reconexiones', unit: '/s', hint: 'Clientes que vuelven con su último id' },
]

function Dashboard({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const { state, status, statusDetail } = useVerification(session, 'coordinator', onLogout)
  const [metrics, setMetrics] = useState<MetricsResponse | null>(null)
  const [metricsError, setMetricsError] = useState(false)
  const [mock, setMock] = useState<MockState | null>(null)
  const now = useNow(1000)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const m = await getMetrics(session.token)
        if (alive) {
          setMetrics(m)
          setMetricsError(false)
        }
      } catch {
        if (alive) setMetricsError(true)
      }
      const s = await getMockState()
      if (alive) setMock(s)
    }
    void load()
    const timer = setInterval(load, 2000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [session.token])

  const history = (metrics?.history ?? []).slice(-120)
  const cases = Object.values(state.cases)
  const locked = cases.filter((c) => c.lockedBy && (c.lockExpiresAt ?? 0) > now).length

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <strong>Operación de la jornada</strong>
          <small>Coordinador {session.username}</small>
        </div>
        <div className="row">
          <ConnectionBadge status={status} detail={statusDetail} />
          <button className="btn btn-small" type="button" onClick={onLogout}>Salir</button>
        </div>
      </header>
      <main className="app-main stack">
        <section aria-labelledby="kpi-title" className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="kpi-title">Instrumentación (RT-7)</h2>
            {metricsError && <span className="badge badge-bad">Sin métricas: GET /api/v1/metrics no responde</span>}
          </div>
          <div className="kpis">
            {KPIS.map((k) => {
              const values = history.map((h) => h[k.key])
              const last = values.length ? values[values.length - 1] : 0
              return (
                <article key={k.key} className="card kpi" title={k.hint}>
                  <span className="kpi-label">{k.label}</span>
                  <strong className="kpi-value num">
                    {formatInt(last)}
                    <span className="kpi-unit">{k.unit}</span>
                  </strong>
                  <Sparkline values={values} label={k.label} />
                  <span className="muted small">{k.hint}</span>
                </article>
              )
            })}
          </div>
        </section>

        <section className="card stack" aria-labelledby="instances-title">
          <h2 id="instances-title">Instancias</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Instancia</th>
                  <th scope="col" className="num">SSE</th>
                  <th scope="col" className="num">WebSocket</th>
                  <th scope="col" className="num">Mensajes/s</th>
                  <th scope="col" className="num">Event Loop</th>
                  <th scope="col" className="num">Recepción → publicación</th>
                </tr>
              </thead>
              <tbody>
                {(metrics?.instances ?? []).map((i) => (
                  <tr key={i.instanceId}>
                    <th scope="row" className="mono">{i.instanceId}</th>
                    <td className="num">{formatInt(i.sseConnections)}</td>
                    <td className="num">{formatInt(i.wsConnections)}</td>
                    <td className="num">{formatInt(i.messagesPerSecond)}</td>
                    <td className="num">{i.eventLoopLagMs} ms</td>
                    <td className="num">{formatInt(i.publishLatencyMs)} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card stack" aria-labelledby="presence-title">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2 id="presence-title">Auditores (RF-8)</h2>
            <span className="muted small">
              {cases.length} actas en cola · {locked} en revisión
            </span>
          </div>
          {state.presence.length === 0 ? (
            <p className="muted">No hay auditores conectados.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Auditor</th>
                    <th scope="col">Trabajando en</th>
                    <th scope="col">Desde hace</th>
                    <th scope="col">Instancia</th>
                    <th scope="col">Último latido</th>
                  </tr>
                </thead>
                <tbody>
                  {state.presence.map((p) => {
                    const silent = now - p.lastSeen
                    return (
                      <tr key={p.auditorId}>
                        <th scope="row">{p.name}</th>
                        <td className="mono">{p.ballotId ?? <span className="muted">disponible</span>}</td>
                        <td className="num">{p.caseSince ? formatDuration(now - p.caseSince) : '—'}</td>
                        <td className="mono">{p.instanceId}</td>
                        <td>
                          <span className={`badge ${silent > 15_000 ? 'badge-warn' : 'badge-ok'}`}>hace {formatDuration(silent)}</span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted small" style={{ margin: 0 }}>
            Una conexión que se corta sin aviso deja de latir y desaparece sola al vencer su tiempo de vida: no quedan auditores fantasma.
          </p>
        </section>

        {mock && <MockControls state={mock} onChange={setMock} />}
      </main>
    </>
  )
}

function MockControls({ state, onChange }: { state: MockState; onChange: (s: MockState | null) => void }) {
  const refresh = async () => onChange(await getMockState())
  const run = (action: () => Promise<unknown>) => () => void action().then(refresh)

  return (
    <section className="card stack" aria-labelledby="demo-title">
      <h2 id="demo-title">Controles de demostración (solo servidor simulado)</h2>
      <p className="muted small" style={{ margin: 0 }}>
        Instancia {state.instanceId} · {state.tablesReported} de {state.tablesTotal} mesas · {state.doubtfulCases} dudosas en cola
      </p>
      <div className="row">
        <button className={`btn ${state.chaos.redisDown ? 'btn-danger' : ''}`} type="button" onClick={run(() => mockControls.redis(state.chaos.redisDown))}>
          {state.chaos.redisDown ? 'Redis CAÍDO · restaurar' : 'Simular caída de Redis'}
        </button>
        <button className="btn" type="button" onClick={run(() => mockControls.dropResponses(state.chaos.dropResponseRate > 0 ? 0 : 0.5))}>
          {state.chaos.dropResponseRate > 0 ? 'Dejar de soltar respuestas' : 'Soltar 50 % de confirmaciones'}
        </button>
        <button className="btn" type="button" onClick={run(() => mockControls.kill())}>
          Matar todas las conexiones
        </button>
        <button className="btn" type="button" onClick={run(() => mockControls.simulator(!state.simulator.running))}>
          {state.simulator.running ? 'Pausar simulador' : 'Reanudar simulador'}
        </button>
        <button className="btn" type="button" onClick={run(() => mockControls.simulator(true, state.simulator.intervalMs > 100 ? 50 : 400))}>
          {state.simulator.intervalMs > 100 ? 'Simular el pico (×8)' : 'Ritmo normal'}
        </button>
      </div>
    </section>
  )
}
