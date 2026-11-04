import '@shared/ui/base.css'
import './styles.css'
import { onINP } from 'web-vitals'
import { PUBLIC_EVENT_TYPES, type Catalog, type PublicEvent, type Topic } from '@shared/contracts/messages'
import { FALLBACK_CANDIDATES, getCatalog } from '@shared/api/catalog'
import { fetchTotals, isTopic } from '@shared/api/results'
import { backoffDelay } from '@shared/transport/backoff'
import { SseClient } from '@shared/transport/sse-client'
import type { ConnectionStatus } from '@shared/transport/status'
import { createMetrics, percentile, recordLatency } from './client-metrics'
import { applyEvent, applyPolled, initialState, type ResultsState } from './state'
import { buildView, h, renderDebug, renderState, renderStatus, topicName } from './view'

// ---- URL parameters (demo switches) -------------------------------------------------------
const params = new URLSearchParams(location.search)
const transport = params.get('transport') === 'polling' ? 'polling' : 'sse'
const jitter = params.get('jitter') !== 'off'
const debug = params.get('debug') === '1'
const requested = params.get('topic') ?? 'department'
let topic: Topic = isTopic(requested) ? requested : 'department'

const refs = buildView(document.querySelector<HTMLElement>('#app')!)
const metrics = createMetrics(transport)
let catalog: Catalog | null = null
let candidates = FALLBACK_CANDIDATES

// ---- Continuity across reloads (RF-6): last id + state per topic in sessionStorage ---------
const storageKey = (t: Topic) => `elections.results.${t}`

function restore(t: Topic): { state: ResultsState; lastEventId?: string } {
  try {
    const raw = sessionStorage.getItem(storageKey(t))
    if (raw) {
      const saved = JSON.parse(raw) as { lastEventId?: string; state: Partial<ResultsState> }
      return { state: initialState(t, saved.state), lastEventId: saved.lastEventId }
    }
  } catch {
    // ignore
  }
  return { state: initialState(t) }
}

let persistTimer: ReturnType<typeof setTimeout> | undefined
function persist(): void {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      sessionStorage.setItem(
        storageKey(state.topic),
        JSON.stringify({ lastEventId: sse?.lastId, state: { totals: state.totals, updatedAt: state.updatedAt, instanceId: state.instanceId, corrections: state.corrections } }),
      )
    } catch {
      // ignore
    }
  }, 500)
}

const restored = restore(topic)
let state = restored.state

// ---- Rendering: at most once per animation frame (RT-9) ------------------------------------
let frameRequested = false
let connection: ConnectionStatus = 'connecting'
let connectionDetail = ''

function scheduleRender(): void {
  if (frameRequested) return
  frameRequested = true
  requestAnimationFrame(() => {
    frameRequested = false
    renderStatus(refs, connection, connectionDetail)
    const via = transport === 'sse' ? 'SSE' : 'polling cada 2 s'
    renderState(refs, state, catalog, candidates, `Servidor ${state.instanceId ?? '—'} · transporte ${via}${jitter ? '' : ' · jitter apagado'}`)
  })
}

function setState(next: ResultsState): void {
  if (next === state) return
  state = next
  metrics.anomalies = state.anomalies.length
  persist()
  scheduleRender()
}

function onStatus(status: ConnectionStatus, info: { attempt: number; delayMs?: number }): void {
  connection = status
  connectionDetail = status === 'reconnecting' && info.delayMs !== undefined ? `(en ${Math.ceil(info.delayMs / 1000)} s)` : ''
  if (status === 'reconnecting' && info.delayMs !== undefined) metrics.reconnects++
  scheduleRender()
}

// ---- Transport 1: SSE ------------------------------------------------------------------
let sse: SseClient<PublicEvent> | null = null

function startSse(lastEventId?: string): void {
  sse = new SseClient<PublicEvent>({
    url: '/api/v1/stream',
    params: { topic },
    eventTypes: PUBLIC_EVENT_TYPES,
    resetTypes: ['snapshot'],
    initialLastEventId: lastEventId,
    // First reconnection window of 5 s: with 50.000 clients per instance, spreading the return over
    // 5 s instead of 0,5 s divides the peak by 10. Nothing is lost meanwhile thanks to lastEventId (RF-6).
    backoff: { jitter, baseMs: 5000, capMs: 60_000 },
    onStatus,
    onEvent: (type, event) => {
      metrics.messages++
      metrics.usefulMessages++
      metrics.bytes += JSON.stringify(event).length
      if (type === 'snapshot') metrics.snapshots++
      recordLatency(metrics, event.at)
      setState(applyEvent(state, event))
    },
  })
  sse.start()
}

// ---- Transport 2: polling (only to measure the comparison of section 7) ---------------------
let pollTimer: ReturnType<typeof setTimeout> | undefined
let pollFailures = 0

function startPolling(): void {
  const tick = async () => {
    const polledTopic = topic
    try {
      const { totals, bytes } = await fetchTotals(polledTopic)
      if (polledTopic !== topic) return
      metrics.messages++
      metrics.bytes += bytes
      const changed = JSON.stringify(totals) !== JSON.stringify(state.totals)
      if (changed) metrics.usefulMessages++
      pollFailures = 0
      onStatus('open', { attempt: 0 })
      if (changed) setState(applyPolled(state, totals, Date.now()))
      pollTimer = setTimeout(tick, 2000)
    } catch {
      const delayMs = backoffDelay(pollFailures++, { jitter, baseMs: 5000, capMs: 60_000 })
      onStatus('reconnecting', { attempt: pollFailures, delayMs })
      pollTimer = setTimeout(tick, delayMs)
    }
  }
  pollTimer = setTimeout(tick, Math.random() * 2000) // spread the first request
}

function startTransport(lastEventId?: string): void {
  if (transport === 'sse') startSse(lastEventId)
  else startPolling()
}

// ---- Topic picker (RF-5) ------------------------------------------------------------------
function changeTopic(next: Topic): void {
  if (next === topic) return
  topic = next
  const url = new URL(location.href)
  url.searchParams.set('topic', next)
  history.replaceState(null, '', url)
  const r = restore(next)
  state = r.state
  scheduleRender()
  if (sse) {
    sse.stop()
    startSse(r.lastEventId)
  } else {
    clearTimeout(pollTimer)
    startPolling()
  }
}

function buildPicker(): void {
  if (!catalog) {
    const input = h('input', { class: 'input', value: topic, 'aria-label': 'Tópico (department, municipality:11, station:110)' }) as HTMLInputElement
    const button = h('button', { class: 'btn', type: 'button' }, 'Ver')
    button.addEventListener('click', () => {
      if (isTopic(input.value.trim())) changeTopic(input.value.trim() as Topic)
    })
    refs.picker.replaceChildren(h('div', { class: 'row' }, input, button))
    return
  }
  const muni = h('select', { class: 'input', id: 'pick-muni' }) as HTMLSelectElement
  const station = h('select', { class: 'input', id: 'pick-station' }) as HTMLSelectElement
  muni.append(new Option(`Todo el departamento`, ''))
  for (const m of catalog.municipalities) muni.append(new Option(m.name, String(m.id)))

  const fillStations = (muniId: string) => {
    station.replaceChildren(new Option('Todo el municipio', ''))
    const m = catalog?.municipalities.find((x) => String(x.id) === muniId)
    for (const s of m?.stations ?? []) station.append(new Option(s.name, String(s.id)))
    station.disabled = !m
  }

  // Preselect from the current topic.
  const [kind, id] = topic.split(':')
  if (kind === 'municipality') muni.value = id
  if (kind === 'station') {
    const owner = catalog.municipalities.find((m) => m.stations.some((s) => String(s.id) === id))
    if (owner) muni.value = String(owner.id)
  }
  fillStations(muni.value)
  if (kind === 'station') station.value = id

  muni.addEventListener('change', () => {
    fillStations(muni.value)
    changeTopic(muni.value ? `municipality:${Number(muni.value)}` : 'department')
  })
  station.addEventListener('change', () => {
    changeTopic(station.value ? `station:${Number(station.value)}` : `municipality:${Number(muni.value)}`)
  })

  refs.picker.replaceChildren(
    h('div', { class: 'picker-grid' }, h('label', { class: 'field', for: 'pick-muni' }, h('span', {}, 'Municipio'), muni), h('label', { class: 'field', for: 'pick-station' }, h('span', {}, 'Puesto de votación'), station)),
  )
  const dept = document.querySelector('[data-dept]')
  if (dept) dept.textContent = catalog.department
  document.title = `${topicName(topic, catalog)} · Preconteo`
}

// ---- Debug panel and INP (RT-9) ------------------------------------------------------------
onINP((metric) => {
  metrics.inp = Math.round(metric.value)
}, { reportAllChanges: true })

if (debug) {
  setInterval(() => {
    const seconds = Math.max(1, (Date.now() - metrics.startedAt) / 1000)
    renderDebug(refs, [
      ['Transporte', metrics.transport],
      ['Mensajes recibidos', String(metrics.messages)],
      ['Mensajes útiles', `${metrics.usefulMessages} (${metrics.messages ? Math.round((metrics.usefulMessages / metrics.messages) * 100) : 0} %)`],
      ['Bytes recibidos', `${metrics.bytes} (${Math.round(metrics.bytes / seconds)} B/s)`],
      ['Latencia p50 / p95', `${percentile(metrics.latencies, 50)} / ${percentile(metrics.latencies, 95)} ms`],
      ['Reconexiones', String(metrics.reconnects)],
      ['Snapshots', String(metrics.snapshots)],
      ['Último id', sse?.lastId ?? '—'],
      ['INP', metrics.inp === null ? 'sin interacción aún' : `${metrics.inp} ms`],
      ['Anomalías', state.anomalies.length ? state.anomalies.join(' · ') : 'ninguna'],
      ['Jitter', jitter ? 'activo' : 'APAGADO'],
    ])
  }, 1000)
}

// ---- Boot ------------------------------------------------------------------------------------
scheduleRender()
startTransport(restored.lastEventId)
getCatalog()
  .then((c) => {
    catalog = c
    candidates = c.candidates
  })
  .catch(() => {
    catalog = null
  })
  .finally(() => {
    buildPicker()
    scheduleRender()
  })
