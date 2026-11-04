// Reproducible load test (RT-8) for the election night profile.
//
//   node load-test/run.mjs --sse 20000 --workers 4 --duration 120
//   node load-test/run.mjs --sse 5000 --kill-at 40 --jitter off --out results/no-jitter.csv
//   (--base 5000: first reconnection window in ms, the same the public page uses)
//   node load-test/report.mjs results/jitter.csv results/no-jitter.csv
//
// It opens N public SSE connections spread across topics (child processes), WebSocket auditors,
// and poll workers that submit tally sheets following the night profile (55 % in the first third,
// bursts, 4–11 % resends with the same idem). Every second it prints and records:
// open connections, connection attempts, reconnections, events received, latency at → receipt.

import { fork } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

const here = dirname(fileURLToPath(import.meta.url))
const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, Infinity]

// ---- Options -----------------------------------------------------------------------------
const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}
const config = {
  target: opt('target', 'http://localhost:8080'),
  sse: Number(opt('sse', 20000)),
  workers: Number(opt('workers', 4)),
  auditors: Number(opt('auditors', 120)),
  duration: Number(opt('duration', 120)),
  rampPerSecond: Number(opt('ramp', 2000)),
  jitter: opt('jitter', 'on') !== 'off',
  baseMs: Number(opt('base', 5000)),
  reset: opt('reset', 'yes') !== 'no',
  killAt: Number(opt('kill-at', 0)),
  pauseSimulator: opt('pause-sim', 'yes') !== 'no',
  out: resolve(here, opt('out', `results/run-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`)),
}

const api = (path) => new URL(`/api/v1${path}`, config.target).toString()

async function post(path, body, headers = {}) {
  const res = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

// ---- Catalog and topics ----------------------------------------------------------------------
const catalog = await fetch(api('/catalog')).then((r) => r.json()).catch(() => null)
if (!catalog) {
  console.error(`No se pudo leer ${api('/catalog')}. ¿Está corriendo el backend o el mock?`)
  process.exit(1)
}
const topics = ['department']
const tables = []
for (const m of catalog.municipalities) {
  topics.push(`municipality:${m.id}`)
  for (const s of m.stations) {
    topics.push(`station:${s.id}`)
    for (const t of s.tables) tables.push({ mesa: t, puesto: s.id, municipio: m.id })
  }
}

if (config.reset) await post('/mock/reset', {}).catch(() => null)
if (config.pauseSimulator) await post('/mock/sim', { running: false }).catch(() => null)

console.log(`Objetivo ${config.target} · ${config.sse} SSE en ${config.workers} procesos · ${config.auditors} auditores · ${config.duration} s · jitter ${config.jitter ? 'ON' : 'OFF'}`)
console.log(`${topics.length} tópicos · ${tables.length} mesas a transmitir`)

// ---- SSE workers -------------------------------------------------------------------------------
const latest = new Map()
const workers = []
const perWorker = Math.ceil(config.sse / config.workers)
for (let w = 0; w < config.workers; w++) {
  const child = fork(resolve(here, 'sse-worker.mjs'))
  const connections = Math.max(0, Math.min(perWorker, config.sse - w * perWorker))
  child.send({
    type: 'start',
    config: { target: config.target, connections, topics, offset: w * perWorker, jitter: config.jitter, baseMs: config.baseMs, rampPerSecond: config.rampPerSecond / config.workers },
  })
  child.on('message', (m) => m.type === 'stats' && latest.set(w, m))
  workers.push(child)
}

// ---- Auditors (WebSocket) --------------------------------------------------------------------
const auditorSockets = []
let wsMessages = 0
if (config.auditors > 0) {
  const sessions = []
  for (const username of ['auditor1', 'auditor2']) {
    const { body } = await post('/auth/login', { username, password: 'pass123' }).catch(() => ({ body: null }))
    if (body?.token) sessions.push(body.token)
  }
  for (let i = 0; i < config.auditors && sessions.length; i++) {
    const url = new URL('/ws/verification', config.target)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('token', sessions[i % sessions.length])
    const ws = new WebSocket(url)
    ws.on('message', () => wsMessages++)
    ws.on('error', () => {})
    auditorSockets.push(ws)
  }
  setInterval(() => {
    for (const ws of auditorSockets) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'heartbeat', active: Math.random() < 0.8 }))
  }, 10_000)
}

// ---- Poll workers: the election night profile ---------------------------------------------------
// 55 % of the sheets in the first third of the test, the rest spread over the remaining time.
const ballots = { sent: 0, resent: 0, statuses: {}, totalMs: 0, applied: 0 }
const schedule = tables
  .map((t, i) => {
    const early = i < tables.length * 0.55
    const span = config.duration * 1000 * 0.9
    const at = early ? Math.random() * (span / 3) : span / 3 + Math.random() * (span * 2 / 3)
    return { t, at }
  })
  .sort((a, b) => a.at - b.at)

const startedAt = Date.now()
const resendRate = 0.04 + Math.random() * 0.07

async function sendSheet(sheet, isResend) {
  const t0 = Date.now()
  try {
    const { status, body } = await post('/ballots', sheet, { 'X-Client-Id': sheet.jurado })
    ballots.totalMs += Date.now() - t0
    const key = body?.status ?? `HTTP ${status}`
    ballots.statuses[key] = (ballots.statuses[key] ?? 0) + 1
    if (key === 'REGISTERED' || key === 'ACCEPTED') ballots.applied++
  } catch {
    ballots.statuses.network_error = (ballots.statuses.network_error ?? 0) + 1
  }
  if (isResend) ballots.resent++
  else ballots.sent++
}

function makeSheet({ mesa, puesto, municipio }) {
  const r = (a, b) => a + Math.floor(Math.random() * (b - a + 1))
  const votos = { C1: r(40, 260), C2: r(40, 260), C3: r(40, 260), BLANCO: r(0, 25), NULO: r(0, 12), NO_MARCADO: r(0, 6) }
  const sum = Object.values(votos).reduce((a, b) => a + b, 0)
  return {
    acta: `E14-${puesto}-${String(mesa).padStart(4, '0')}-${catalog.corporation ?? '03'}`,
    mesa, puesto, municipio, version: 1,
    jurado: `LOAD-${mesa}`,
    ts_cierre: Math.floor(Date.now() / 1000),
    votos,
    sufragantes: Math.random() < 0.07 ? sum + 1 : sum,
    hash_foto: randomUUID().replaceAll('-', ''),
    idem: randomUUID().replaceAll('-', '').slice(0, 16),
  }
}

let scheduleIndex = 0
const sendTimer = setInterval(() => {
  const elapsed = Date.now() - startedAt
  while (scheduleIndex < schedule.length && schedule[scheduleIndex].at <= elapsed) {
    const sheet = makeSheet(schedule[scheduleIndex++].t)
    void sendSheet(sheet, false)
    // Bad network: the poll worker did not see the confirmation and resends the SAME sheet and idem.
    if (Math.random() < resendRate) setTimeout(() => void sendSheet(sheet, true), 500 + Math.random() * 3000)
  }
}, 50)

// ---- Kill scenario (RF-10) ------------------------------------------------------------------
if (config.killAt > 0) {
  setTimeout(() => {
    console.log(`\n>>> t=${config.killAt}s: matando todas las conexiones (POST /api/v1/mock/kill)\n`)
    void post('/mock/kill', {}).catch(() => console.log('No hay /mock/kill: mata una instancia del backend a mano ahora.'))
  }, config.killAt * 1000)
}

// ---- Per-second aggregation -----------------------------------------------------------------------
const rows = []
let totalEvents = 0
const totalLatency = BUCKETS.map(() => 0)

function percentileFromBuckets(buckets, p) {
  const total = buckets.reduce((a, b) => a + b, 0)
  if (!total) return 0
  let acc = 0
  for (let i = 0; i < buckets.length; i++) {
    acc += buckets[i]
    if (acc / total >= p / 100) return BUCKETS[i] === Infinity ? 10_000 : BUCKETS[i]
  }
  return 0
}

console.log('\n   t | abiertas | intentos/s | reconex/s | eventos/s |  p50 |  p95 |  p99 | actas')
const tick = setInterval(() => {
  const t = Math.round((Date.now() - startedAt) / 1000)
  const agg = { open: 0, connectAttempts: 0, reconnects: 0, events: 0, bytes: 0, errors: 0, latency: BUCKETS.map(() => 0) }
  for (const s of latest.values()) {
    agg.open += s.open
    agg.connectAttempts += s.connectAttempts
    agg.reconnects += s.reconnects
    agg.events += s.events
    agg.bytes += s.bytes
    agg.errors += s.errors
    s.latency.forEach((v, i) => (agg.latency[i] += v))
  }
  latest.clear()
  totalEvents += agg.events
  agg.latency.forEach((v, i) => (totalLatency[i] += v))
  const row = {
    t,
    sseOpen: agg.open,
    connectAttempts: agg.connectAttempts,
    reconnects: agg.reconnects,
    events: agg.events,
    bytes: agg.bytes,
    errors: agg.errors,
    p50: percentileFromBuckets(agg.latency, 50),
    p95: percentileFromBuckets(agg.latency, 95),
    p99: percentileFromBuckets(agg.latency, 99),
    ballotsSent: ballots.sent,
  }
  rows.push(row)
  const pad = (v, n) => String(v).padStart(n)
  console.log(`${pad(t, 4)} | ${pad(row.sseOpen, 8)} | ${pad(row.connectAttempts, 10)} | ${pad(row.reconnects, 9)} | ${pad(row.events, 9)} | ${pad(row.p50, 4)} | ${pad(row.p95, 4)} | ${pad(row.p99, 4)} | ${pad(row.ballotsSent, 5)}`)
}, 1000)

// ---- End -----------------------------------------------------------------------------------------
setTimeout(() => {
  clearInterval(tick)
  clearInterval(sendTimer)
  for (const w of workers) w.send({ type: 'stop' })
  for (const ws of auditorSockets) ws.terminate()

  mkdirSync(dirname(config.out), { recursive: true })
  const header = Object.keys(rows[0] ?? { t: 0 })
  writeFileSync(config.out, [header.join(','), ...rows.map((r) => header.map((h) => r[h]).join(','))].join('\n'))

  const naive = ballots.sent * config.sse
  console.log('\n===== Resumen =====')
  console.log(`Actas enviadas: ${ballots.sent} (+${ballots.resent} reenvíos con el mismo idem, tasa ${(resendRate * 100).toFixed(1)} %)`)
  console.log(`Respuestas: ${JSON.stringify(ballots.statuses)} · tiempo medio ${ballots.sent ? Math.round(ballots.totalMs / (ballots.sent + ballots.resent)) : 0} ms`)
  console.log(`Eventos recibidos por el público: ${totalEvents}`)
  console.log(`Cifra ingenua (un mensaje por acta y por cliente): ${ballots.sent} × ${config.sse} = ${naive}`)
  console.log(`Reducción por agregación en ventanas + tópicos: ${naive ? (naive / Math.max(1, totalEvents)).toFixed(1) : '-'} veces menos mensajes`)
  console.log(`Latencia at → recepción: p50 ${percentileFromBuckets(totalLatency, 50)} ms · p95 ${percentileFromBuckets(totalLatency, 95)} ms · p99 ${percentileFromBuckets(totalLatency, 99)} ms`)
  console.log(`Mensajes WebSocket recibidos por auditores: ${wsMessages}`)
  console.log(`CSV: ${config.out}`)
  if (config.pauseSimulator) void post('/mock/sim', { running: true }).catch(() => null)
  setTimeout(() => process.exit(0), 300)
}, config.duration * 1000)
