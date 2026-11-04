// Mock of the Spring Boot backend (github.com/DirkinYohan/elections), following CONTRACT.md.
// It lets the frontend be built, demoed and load-tested without the real backend.
// Everything lives in memory: this imitates the behaviour of the real system, it is NOT the real system.
//
// Run: npm run mock   (port 8080, the same as Spring, so the Vite proxy needs no change)

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8080)
const INSTANCE_ID = process.env.INSTANCE_ID ?? `mock-${process.pid}`
const API = '/api/v1'
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2000) // aggregation window (RF-4)
const RETENTION = Number(process.env.RETENTION ?? 300) // events kept per topic, like XADD MAXLEN (RF-6)
const SLOW_CLIENT_BYTES = 256 * 1024 // pending output that marks an SSE client as slow (RF-9)
const FANOUT_BATCH = 500 // connections per batch before yielding the event loop (RF-4)
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS ?? 30_000) // auditor lock (RF-7)
const HEARTBEAT_MS = 10_000
const PRESENCE_TTL_MS = 25_000 // no heartbeat for this long = ghost connection (RF-8)
const RATE_LIMIT_PER_MINUTE = 120 // per X-Client-Id, like SecurityApi.checkRateLimit

// ---------------------------------------------------------------------------
// Catalog: 3 municipalities × 5 stations × N tables (fictional names)
// ---------------------------------------------------------------------------

const TABLES_PER_STATION = Number(process.env.TABLES_PER_STATION ?? 20)
const MUNICIPALITY_NAMES = { 11: 'San Miguel', 12: 'Santa Rosa', 13: 'El Carmen' }
const STATION_NAMES = ['Escuela Central', 'Colegio Departamental', 'Coliseo Municipal', 'Institución Técnica', 'Casa de la Cultura']

const catalog = {
  department: 'Departamento de demostración',
  corporation: '03',
  candidates: [
    { key: 'C1', name: 'Laura Méndez', party: 'Movimiento Río' },
    { key: 'C2', name: 'Andrés Ospina', party: 'Partido Cordillera' },
    { key: 'C3', name: 'Carmen Ruiz', party: 'Coalición Horizonte' },
  ],
  municipalities: [],
}

const tables = [] // { mesa, puesto, municipio }
{
  let mesa = 1
  for (const [id, name] of Object.entries(MUNICIPALITY_NAMES)) {
    const municipio = Number(id)
    const stations = []
    for (let k = 0; k < STATION_NAMES.length; k++) {
      const puesto = municipio * 10 + k
      const stationTables = []
      for (let t = 0; t < TABLES_PER_STATION; t++) {
        stationTables.push(mesa)
        tables.push({ mesa, puesto, municipio })
        mesa++
      }
      stations.push({ id: puesto, name: `${STATION_NAMES[k]} (${name})`, tables: stationTables })
    }
    catalog.municipalities.push({ id: municipio, name, stations })
  }
}

const VOTE_KEYS = [...catalog.candidates.map((c) => c.key), 'BLANCO', 'NULO', 'NO_MARCADO']
const topicsOf = (s) => ['department', `municipality:${s.municipio}`, `station:${s.puesto}`]
const emptyVotes = () => Object.fromEntries(VOTE_KEYS.map((k) => [k, 0]))

const tablesTotal = new Map()
for (const t of tables) for (const topic of topicsOf(t)) tablesTotal.set(topic, (tablesTotal.get(topic) ?? 0) + 1)

// ---------------------------------------------------------------------------
// Identity (same demo users as the backend's UserRepository, plus a second auditor and jury)
// ---------------------------------------------------------------------------

const USERS = {
  jury1: { password: 'pass123', role: 'JURY' },
  jury2: { password: 'pass123', role: 'JURY' },
  auditor1: { password: 'pass123', role: 'AUDITOR' },
  auditor2: { password: 'pass123', role: 'AUDITOR' },
  coordinator1: { password: 'pass123', role: 'COORDINATOR' },
}
const sessions = new Map() // token -> session

function sessionFrom(token) {
  const s = token ? sessions.get(token) : null
  return s && s.expiresAt > Date.now() ? s : null
}

// ---------------------------------------------------------------------------
// State (in the real system all of this lives in Redis)
// ---------------------------------------------------------------------------

let applied, submissions, idemKeys, totals, published, logs, dirty, pendingCorrections, cases, locks, sentByTable, rateCounters
function resetState() {
  applied = new Map() // acta -> sheet currently counted
  submissions = new Map() // `${acta}#${version}` -> SubmitResponse (permanent idempotency)
  idemKeys = new Map() // idem -> `${acta}#${version}`
  totals = new Map() // topic -> live totals
  published = new Map() // topic -> totals as of the last event (what snapshots show)
  logs = new Map() // topic -> [{ id, type, frame }] (stands in for a Redis Stream per topic)
  dirty = new Map() // topic -> first time it changed in this window (publish latency)
  pendingCorrections = new Map() // topic -> CorrectionInfo[]
  cases = new Map() // ballotId -> VerificationCase
  locks = new Map() // ballotId -> { auditorId, auditorName, token, connId, expiresAt, since }
  sentByTable = new Map() // simulator memory: mesa -> last sheet sent
  rateCounters = new Map() // clientId -> { windowStart, count }
}
resetState()

const chaos = { redisDown: false, dropResponseRate: 0 }
const sim = { running: true, intervalMs: Number(process.env.SIM_INTERVAL_MS ?? 400), timer: null }

function totalsFor(topic) {
  let t = totals.get(topic)
  if (!t) {
    t = { votes: emptyVotes(), tablesReported: 0, tablesTotal: tablesTotal.get(topic) ?? 0 }
    totals.set(topic, t)
  }
  return t
}

const clone = (t) => ({ votes: { ...t.votes }, tablesReported: t.tablesReported, tablesTotal: t.tablesTotal })
const sumVotes = (votos) => Object.values(votos).reduce((a, b) => a + b, 0)

// Monotonic ids with the shape of Redis Stream ids: <ms>-<seq>
let lastMs = 0
let seq = 0
function nextStreamId() {
  const now = Date.now()
  if (now > lastMs) {
    lastMs = now
    seq = 0
  } else {
    seq++
  }
  return `${lastMs}-${seq}`
}

function compareIds(a, b) {
  const [am, as = 0n] = a.split('-').map(BigInt)
  const [bm, bs = 0n] = b.split('-').map(BigInt)
  if (am !== bm) return am < bm ? -1 : 1
  if (as !== bs) return as < bs ? -1 : 1
  return 0
}

// ---------------------------------------------------------------------------
// Applying tally sheets (RF-1, RF-2, RF-3)
// ---------------------------------------------------------------------------

/** In the real system this whole function is ONE Lua script, so it is atomic across the 4 levels. */
function applySheet(sheet, reason = 'Acta corregida por el jurado') {
  const prev = applied.get(sheet.acta)
  for (const topic of topicsOf(sheet)) {
    const t = totalsFor(topic)
    if (prev) {
      for (const [k, v] of Object.entries(prev.votos)) t.votes[k] = (t.votes[k] ?? 0) - v
      const list = pendingCorrections.get(topic) ?? []
      list.push({ ballotId: sheet.acta, fromVersion: prev.version, toVersion: sheet.version, reason })
      pendingCorrections.set(topic, list)
    } else {
      t.tablesReported++
    }
    for (const [k, v] of Object.entries(sheet.votos)) t.votes[k] = (t.votes[k] ?? 0) + v
    if (!dirty.has(topic)) dirty.set(topic, Date.now())
  }
  applied.set(sheet.acta, sheet)
}

function validate(s) {
  if (!s || typeof s !== 'object') return 'Cuerpo vacío o no es JSON'
  if (typeof s.acta !== 'string' || !/^E14-\d+-\d+-\d+$/.test(s.acta)) return '"acta" debe tener la forma E14-puesto-mesa-corporación'
  if (typeof s.idem !== 'string' || !s.idem) return 'Falta "idem"'
  for (const f of ['mesa', 'puesto', 'municipio', 'version', 'sufragantes']) {
    if (!Number.isInteger(s[f]) || s[f] < 0) return `"${f}" debe ser un entero no negativo`
  }
  if (s.version < 1) return '"version" empieza en 1'
  if (!s.votos || typeof s.votos !== 'object' || !Object.keys(s.votos).length) return 'Faltan los votos'
  for (const [k, v] of Object.entries(s.votos)) {
    if (!Number.isInteger(v) || v < 0) return `Votos inválidos para ${k}`
  }
  return null
}

const submitLog = [] // timestamps of stored submissions (ballots per minute)

/** Returns [httpStatus, SubmitResponse] */
function submit(sheet) {
  const acta = sheet?.acta ?? ''
  const version = sheet?.version ?? 0
  if (chaos.redisDown) {
    return [503, { status: 'UNAVAILABLE', ballotId: acta, version, message: 'Sistema degradado: el acta NO quedó registrada. Se reintentará sola.' }]
  }
  const error = validate(sheet)
  if (error) return [422, { status: 'REJECTED', ballotId: acta, version, message: error }]

  const key = `${sheet.acta}#${sheet.version}`
  const knownKey = idemKeys.get(sheet.idem) ?? (submissions.has(key) ? key : null)
  if (knownKey) {
    const first = submissions.get(knownKey)
    return [200, { ...first, status: 'DUPLICATE', message: `Ya estaba registrada (${first.status})` }]
  }

  const base = { ballotId: sheet.acta, version: sheet.version, receipt: `R-${randomUUID().slice(0, 8).toUpperCase()}`, registeredAt: Date.now() }
  let result
  const sum = sumVotes(sheet.votos)
  const current = applied.get(sheet.acta)

  if (current && current.version >= sheet.version) {
    result = [200, { ...base, status: 'SUPERSEDED', message: `Ya está aplicada la versión ${current.version}` }]
  } else if (sum !== sheet.sufragantes) {
    result = [202, { ...base, status: 'DOUBTFUL', message: `La suma de votos (${sum}) no coincide con sufragantes (${sheet.sufragantes}). Pasa a verificación.` }]
    addCase(sheet, sum)
  } else {
    applySheet(sheet)
    result = [201, { ...base, status: 'REGISTERED', message: 'Acta registrada' }]
  }

  submissions.set(key, result[1])
  idemKeys.set(sheet.idem, key)
  submitLog.push(Date.now())
  return result
}

function checkRateLimit(clientId) {
  const now = Date.now()
  const c = rateCounters.get(clientId)
  if (!c || now - c.windowStart >= 60_000) {
    rateCounters.set(clientId, { windowStart: now, count: 1 })
    return null
  }
  c.count++
  return c.count > RATE_LIMIT_PER_MINUTE ? Math.ceil((c.windowStart + 60_000 - now) / 1000) : null
}

// ---------------------------------------------------------------------------
// Aggregation window + fan-out (RF-4, RF-5, RF-9)
// ---------------------------------------------------------------------------

const subscribers = new Map() // topic -> Set<res>   (cost proportional to the topic's subscribers)

const frameOf = (id, type, payload) => `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`

function flushWindow() {
  if (chaos.redisDown) return // degraded: nothing new is published
  const now = Date.now()
  for (const [topic, firstChangeAt] of dirty) {
    const cur = totalsFor(topic)
    const prev = published.get(topic) ?? { votes: emptyVotes(), tablesReported: 0, tablesTotal: cur.tablesTotal }
    const changes = {}
    const votes = {}
    for (const k of Object.keys(cur.votes)) if (cur.votes[k] !== prev.votes[k]) votes[k] = cur.votes[k]
    if (Object.keys(votes).length) changes.votes = votes
    if (cur.tablesReported !== prev.tablesReported) changes.tablesReported = cur.tablesReported
    if (cur.tablesTotal !== prev.tablesTotal) changes.tablesTotal = cur.tablesTotal

    const corrections = pendingCorrections.get(topic) ?? []
    pendingCorrections.delete(topic)
    if (!Object.keys(changes).length && !corrections.length) continue

    const id = nextStreamId()
    const payload = corrections.length
      ? { type: 'correction', topic, changes, corrections, at: now }
      : { type: 'delta', topic, changes, at: now }
    const event = { id, type: payload.type, frame: frameOf(id, payload.type, payload) }

    const log = logs.get(topic) ?? []
    log.push(event)
    if (log.length > RETENTION) log.splice(0, log.length - RETENTION)
    logs.set(topic, log)
    published.set(topic, clone(cur))
    metrics.current.events++
    metrics.current.latencySum += now - firstChangeAt
    metrics.current.latencyCount++
    broadcast(topic, event.frame)
  }
  dirty.clear()
}

/** Sends one pre-serialized frame to every subscriber of a topic, in batches that yield the event loop. */
function broadcast(topic, frame) {
  const targets = [...(subscribers.get(topic) ?? [])]
  let i = 0
  const sendBatch = () => {
    const end = Math.min(i + FANOUT_BATCH, targets.length)
    for (; i < end; i++) {
      const res = targets[i]
      if (res.writableLength > SLOW_CLIENT_BYTES) {
        // RF-9 policy: stop feeding a slow client and close it; it comes back with its lastEventId.
        metrics.current.slowDisconnects++
        res.end()
        continue
      }
      res.write(frame)
      metrics.current.messages++
    }
    if (i < targets.length) setImmediate(sendBatch)
  }
  sendBatch()
}

function snapshotFrame(topic) {
  const log = logs.get(topic) ?? []
  const id = log.length ? log[log.length - 1].id : '0-0'
  const base = published.get(topic) ?? { votes: emptyVotes(), tablesReported: 0, tablesTotal: tablesTotal.get(topic) ?? 0 }
  return frameOf(id, 'snapshot', { type: 'snapshot', topic, totals: clone(base), instanceId: INSTANCE_ID, at: Date.now() })
}

function handleStream(req, res, url) {
  const topic = url.searchParams.get('topic') ?? 'department'
  if (!/^(department|municipality:\d+|station:\d+)$/.test(topic)) return json(res, 400, { error: 'Tópico inválido' })
  const lastId = url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  // Send the headers NOW: otherwise a client resuming with nothing new to replay stays "connecting"
  // until the next event of its topic (browsers only fire `open` once headers arrive).
  res.write(': connected\n\n')
  metrics.current.sseConnects++
  if (lastId) metrics.current.reconnects++

  const log = logs.get(topic) ?? []
  const canReplay =
    lastId && /^\d+(-\d+)?$/.test(lastId) && log.length > 0 &&
    compareIds(lastId, log[0].id) >= 0 && compareIds(lastId, log[log.length - 1].id) <= 0

  if (canReplay) {
    for (const e of log) if (compareIds(e.id, lastId) > 0) res.write(e.frame) // only what was missed
  } else if (!(lastId && log.length && lastId === log[log.length - 1].id)) {
    res.write(snapshotFrame(topic)) // first time, or too far behind the retained history
  }

  let set = subscribers.get(topic)
  if (!set) subscribers.set(topic, (set = new Set()))
  set.add(res)
  req.on('close', () => set.delete(res))
}

setInterval(() => {
  for (const set of subscribers.values()) for (const res of set) res.write(': ping\n\n')
}, 15_000)

// ---------------------------------------------------------------------------
// Verification: queue, exclusive locks and presence (RF-7, RF-8) · /ws/verification
// ---------------------------------------------------------------------------

const verificationSockets = new Map() // ws -> { connId, auditorId, name, role, connectedAt, lastSeen }
const jurySockets = new Map() // ws -> { jurado }

function addCase(sheet, sum) {
  const item = {
    ballotId: sheet.acta,
    version: sheet.version,
    municipio: sheet.municipio,
    puesto: sheet.puesto,
    mesa: sheet.mesa,
    jurado: sheet.jurado,
    priority: Math.min(5, 1 + Math.abs(sum - sheet.sufragantes)),
    reason: `La suma de votos (${sum}) no coincide con sufragantes (${sheet.sufragantes})`,
    votos: { ...sheet.votos },
    sufragantes: sheet.sufragantes,
    createdAt: Date.now(),
  }
  cases.set(item.ballotId, item)
  broadcastVerification({ type: 'case_added', item: caseView(item) })
}

function caseView(c) {
  const { jurado: _jurado, ...rest } = c
  const lock = locks.get(c.ballotId)
  return lock && lock.expiresAt > Date.now()
    ? { ...rest, lockedBy: lock.auditorId, lockedByName: lock.auditorName, lockExpiresAt: lock.expiresAt }
    : rest
}

function presenceList() {
  const byAuditor = new Map()
  for (const a of verificationSockets.values()) {
    if (a.role !== 'AUDITOR') continue
    const prev = byAuditor.get(a.auditorId)
    if (!prev || a.lastSeen > prev.lastSeen) byAuditor.set(a.auditorId, a)
  }
  return [...byAuditor.values()].map((a) => {
    const held = [...locks.entries()].find(([, l]) => l.auditorId === a.auditorId)
    return {
      auditorId: a.auditorId,
      name: a.name,
      ballotId: held?.[0],
      caseSince: held?.[1].since,
      connectedAt: a.connectedAt,
      lastSeen: a.lastSeen,
      instanceId: INSTANCE_ID,
    }
  })
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastVerification(msg) {
  const data = JSON.stringify(msg)
  for (const ws of verificationSockets.keys()) if (ws.readyState === ws.OPEN) ws.send(data)
}

const announcePresence = () => broadcastVerification({ type: 'presence', auditors: presenceList() })

function announceLock(ballotId, lock) {
  for (const [ws, a] of verificationSockets) {
    send(ws, {
      type: 'case_locked',
      ballotId,
      auditorId: lock.auditorId,
      auditorName: lock.auditorName,
      lockExpiresAt: lock.expiresAt,
      since: lock.since,
      ...(a.connId === lock.connId ? { lockToken: lock.token } : {}),
    })
  }
}

function notifyJury(item, decision, notes) {
  const msg = JSON.stringify({ type: 'ballot_update', ballotId: item.ballotId, version: item.version, decision, notes, at: Date.now() })
  for (const [ws, j] of jurySockets) if (j.jurado === item.jurado && ws.readyState === ws.OPEN) ws.send(msg)
}

function onVerificationMessage(ws, me, msg) {
  me.lastSeen = Date.now()
  if (msg?.type === 'heartbeat') {
    if (!msg.active) return // idle: presence refreshed, lock NOT renewed
    for (const [ballotId, lock] of locks) {
      if (lock.connId === me.connId && lock.expiresAt > Date.now()) {
        lock.expiresAt = Date.now() + LOCK_TTL_MS
        announceLock(ballotId, lock)
      }
    }
    return
  }
  if (me.role !== 'AUDITOR') return send(ws, { type: 'error', code: 'READ_ONLY', message: 'El coordinador solo observa' })

  switch (msg?.type) {
    case 'take_case': {
      if (!cases.has(msg.ballotId)) return send(ws, { type: 'error', code: 'CASE_NOT_FOUND', message: 'El caso ya no existe' })
      const current = locks.get(msg.ballotId)
      const alive = current && current.expiresAt > Date.now()
      if (alive && current.auditorId !== me.auditorId) {
        return send(ws, { type: 'take_rejected', ballotId: msg.ballotId, lockedBy: current.auditorName })
      }
      const holding = [...locks.entries()].find(([id, l]) => l.auditorId === me.auditorId && id !== msg.ballotId && l.expiresAt > Date.now())
      if (holding) return send(ws, { type: 'error', code: 'ALREADY_HOLDING_CASE', message: `Ya estás trabajando en ${holding[0]}` })
      // SET lock:<ballotId> <token> NX PX <ttl> in Redis. A fresh token on every acquisition.
      const lock = { auditorId: me.auditorId, auditorName: me.name, token: randomUUID(), connId: me.connId, expiresAt: Date.now() + LOCK_TTL_MS, since: Date.now() }
      locks.set(msg.ballotId, lock)
      announceLock(msg.ballotId, lock)
      announcePresence()
      return
    }
    case 'resolve_case':
    case 'release_case': {
      const lock = locks.get(msg.ballotId)
      // Safe release: compare-and-delete on the token (a Lua script in Redis). A late auditor whose
      // lock expired and was reassigned holds an old token, so it cannot free the new owner's lock.
      if (!lock || lock.token !== msg.lockToken || lock.expiresAt <= Date.now()) {
        return send(ws, { type: 'error', code: 'LOCK_NOT_OWNED', message: 'Tu bloqueo expiró o el caso ya pertenece a otro auditor' })
      }
      locks.delete(msg.ballotId)
      if (msg.type === 'release_case') {
        broadcastVerification({ type: 'case_released', ballotId: msg.ballotId, reason: 'released' })
      } else {
        const item = cases.get(msg.ballotId)
        cases.delete(msg.ballotId)
        if (item && msg.decision === 'RATIFIED') applySheet({ ...item, acta: item.ballotId }, 'Acta ratificada en verificación')
        if (item && msg.decision === 'CORRECTED' && msg.correctedVotes) {
          applySheet({ ...item, acta: item.ballotId, votos: msg.correctedVotes, sufragantes: sumVotes(msg.correctedVotes) }, 'Acta corregida en verificación')
        }
        if (item) notifyJury(item, msg.decision, msg.notes)
        broadcastVerification({ type: 'case_resolved', ballotId: msg.ballotId, auditorId: me.auditorId, decision: msg.decision })
      }
      announcePresence()
      return
    }
    default:
      send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Tipo de mensaje desconocido' })
  }
}

setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [ballotId, lock] of locks) {
    if (lock.expiresAt <= now) {
      locks.delete(ballotId) // the case goes back to the queue on its own
      broadcastVerification({ type: 'case_released', ballotId, reason: 'expired' })
      changed = true
    }
  }
  for (const [ws, a] of verificationSockets) {
    if (now - a.lastSeen > PRESENCE_TTL_MS) {
      verificationSockets.delete(ws) // laptop out of battery: no close frame ever arrives
      ws.terminate()
      changed = true
    }
  }
  if (changed) announcePresence()
}, 1000)

const verificationWss = new WebSocketServer({ noServer: true })
const juriesWss = new WebSocketServer({ noServer: true })
let connSeq = 0

verificationWss.on('connection', (ws, req, session) => {
  const url = new URL(req.url, 'http://localhost')
  const role = session.role === 'COORDINATOR' || url.searchParams.get('role') === 'coordinator' ? session.role : 'AUDITOR'
  const me = { connId: ++connSeq, auditorId: session.username, name: session.username, role, connectedAt: Date.now(), lastSeen: Date.now() }
  verificationSockets.set(ws, me)
  metrics.current.wsConnects++

  send(ws, { type: 'welcome', auditorId: me.auditorId, name: me.name, role: me.role, instanceId: INSTANCE_ID, lockTtlMs: LOCK_TTL_MS, heartbeatMs: HEARTBEAT_MS })
  send(ws, { type: 'queue_snapshot', cases: [...cases.values()].map(caseView) })
  // Reconnected auditor that still owns a lock: hand the token to the new connection.
  for (const [ballotId, lock] of locks) {
    if (lock.auditorId === me.auditorId && lock.expiresAt > Date.now()) {
      lock.connId = me.connId
      announceLock(ballotId, lock)
    }
  }
  announcePresence()

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'JSON inválido' })
    }
    onVerificationMessage(ws, me, msg)
  })
  ws.on('close', () => {
    // The lock is NOT released here: it expires on its own unless an active heartbeat renews it.
    verificationSockets.delete(ws)
    announcePresence()
  })
})

juriesWss.on('connection', (ws, _req, session) => {
  jurySockets.set(ws, { jurado: session.username })
  ws.on('close', () => jurySockets.delete(ws))
})

// ---------------------------------------------------------------------------
// Simulator: poll workers submitting during the election night
// ---------------------------------------------------------------------------

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1))

function makeSheet(table, version = 1) {
  const votos = { C1: rand(40, 260), C2: rand(40, 260), C3: rand(40, 260), BLANCO: rand(0, 25), NULO: rand(0, 12), NO_MARCADO: rand(0, 6) }
  const sum = sumVotes(votos)
  return {
    acta: `E14-${table.puesto}-${String(table.mesa).padStart(4, '0')}-03`,
    mesa: table.mesa,
    puesto: table.puesto,
    municipio: table.municipio,
    version,
    jurado: `JUR-${rand(10000, 99999)}`,
    ts_cierre: Math.floor(Date.now() / 1000),
    votos,
    sufragantes: Math.random() < 0.07 ? sum + rand(1, 4) : sum, // ~7 % doubtful
    hash_foto: randomUUID().replaceAll('-', ''),
    idem: randomUUID().replaceAll('-', '').slice(0, 16),
  }
}

function simulateStep() {
  const r = Math.random()
  const sent = [...sentByTable.values()]
  if (r < 0.08 && sent.length) return void submit(sent[rand(0, sent.length - 1)]) // resend, same idem
  if (r < 0.1 && sent.length) {
    const prev = sent[rand(0, sent.length - 1)]
    const fixed = makeSheet(prev, prev.version + 1) // correction (RF-2)
    fixed.sufragantes = sumVotes(fixed.votos)
    sentByTable.set(prev.mesa, fixed)
    return void submit(fixed)
  }
  const pending = tables.filter((t) => !sentByTable.has(t.mesa))
  if (!pending.length) return
  const sheet = makeSheet(pending[rand(0, pending.length - 1)])
  sentByTable.set(sheet.mesa, sheet)
  submit(sheet)
}

function restartSimulator() {
  clearInterval(sim.timer)
  sim.timer = sim.running ? setInterval(simulateStep, sim.intervalMs) : null
}

// ---------------------------------------------------------------------------
// Metrics (RT-7)
// ---------------------------------------------------------------------------

const LOOP_RESOLUTION_MS = 10
const loopDelay = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS })
loopDelay.enable()
// Memory of the process with no connections: subtracted to estimate the cost of each connection.
let baselineRss = process.memoryUsage().rss
const newBucket = () => ({ sseConnects: 0, wsConnects: 0, reconnects: 0, messages: 0, events: 0, slowDisconnects: 0, latencySum: 0, latencyCount: 0 })
const metrics = { current: newBucket(), history: [], last: null }

function sseOpenCount() {
  let n = 0
  for (const set of subscribers.values()) n += set.size
  return n
}

setInterval(() => {
  const now = Date.now()
  while (submitLog.length && now - submitLog[0] > 60_000) submitLog.shift()
  const sse = sseOpenCount()
  const ws = verificationSockets.size + jurySockets.size
  const c = metrics.current
  const rss = process.memoryUsage().rss
  if (sse + ws === 0) baselineRss = rss
  const sample = {
    t: now,
    sseConnections: sse,
    wsConnections: ws,
    messagesPerSecond: c.messages,
    // p99 of the timer delay minus the timer's own resolution = how late the loop really was.
    eventLoopLagMs: Math.max(0, Math.round((loopDelay.percentile(99) / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10),
    memoryPerConnectionBytes: sse + ws ? Math.max(0, Math.round((rss - baselineRss) / (sse + ws))) : 0,
    ballotsPerMinute: submitLog.length,
    publishLatencyMs: c.latencyCount ? Math.round(c.latencySum / c.latencyCount) : 0,
    reconnectsPerSecond: c.reconnects,
    connectsPerSecond: c.sseConnects + c.wsConnects,
    slowDisconnects: c.slowDisconnects,
  }
  loopDelay.reset()
  metrics.history.push(sample)
  if (metrics.history.length > 300) metrics.history.shift()
  metrics.last = sample
  metrics.current = newBucket()
}, 1000)

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

function readJson(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 1_000_000) req.destroy()
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch {
        resolve(null)
      }
    })
  })
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}

function aggregateDto(level, identifier, topic) {
  const t = published.get(topic) ?? { votes: emptyVotes(), tablesReported: 0, tablesTotal: tablesTotal.get(topic) ?? 0 }
  return {
    level,
    identifier,
    reportedTables: t.tablesReported,
    totalTables: t.tablesTotal,
    reportedPercentage: t.tablesTotal ? (t.tablesReported / t.tablesTotal) * 100 : 0,
    candidateTotals: { ...t.votes },
  }
}

function killAllConnections() {
  // Simulates an instance dying: all its clients reconnect at once (RF-10).
  for (const set of subscribers.values()) for (const res of set) res.destroy()
  for (const ws of verificationSockets.keys()) ws.terminate()
  for (const ws of jurySockets.keys()) ws.terminate()
}

const bearer = (req) => (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '') || null

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const path = url.pathname.startsWith(API) ? url.pathname.slice(API.length) : null
  if (path === null) return json(res, 404, { error: 'Not found' })
  const route = `${req.method} ${path}`

  if (route === 'GET /stream') return handleStream(req, res, url)

  if (route === 'POST /auth/login') {
    const body = (await readJson(req)) ?? {}
    const user = USERS[body.username]
    if (!user || user.password !== body.password) return json(res, 401, { error: 'Invalid credentials' })
    const session = { token: randomUUID(), username: body.username, role: user.role, expiresAt: Date.now() + 8 * 3600_000 }
    sessions.set(session.token, session)
    return json(res, 200, session)
  }

  if (route === 'GET /catalog') return json(res, 200, catalog)

  if (route === 'POST /ballots') {
    const clientId = String(req.headers['x-client-id'] ?? 'anonymous-jury')
    const retryAfter = checkRateLimit(clientId)
    if (retryAfter) return json(res, 429, { error: 'Rate limit exceeded', retryAfterSeconds: retryAfter })
    const sheet = await readJson(req)
    const [status, body] = submit(sheet)
    if (status < 300 && Math.random() < chaos.dropResponseRate) {
      // Stored, but the "server dies" before confirming: the client must resend with the same idem.
      return req.socket.destroy()
    }
    return json(res, status, body)
  }

  if (route === 'GET /results/department') return json(res, 200, aggregateDto('DEPARTMENT', 'GLOBAL', 'department'))
  let m = /^GET \/results\/municipality\/(\d+)$/.exec(route)
  if (m) return json(res, 200, aggregateDto('MUNICIPALITY', m[1], `municipality:${m[1]}`))
  m = /^GET \/results\/station\/(\d+)$/.exec(route)
  if (m) return json(res, 200, aggregateDto('POLLING_STATION', m[1], `station:${m[1]}`))

  if (route === 'GET /metrics') {
    const last = metrics.last ?? { sseConnections: 0, wsConnections: 0, messagesPerSecond: 0, eventLoopLagMs: 0, memoryPerConnectionBytes: 0, ballotsPerMinute: 0, publishLatencyMs: 0, reconnectsPerSecond: 0 }
    return json(res, 200, { instances: [{ instanceId: INSTANCE_ID, ...last }], history: metrics.history })
  }

  if (route === 'GET /verification/auditors') {
    const s = sessionFrom(bearer(req))
    if (!s || s.role === 'JURY') return json(res, 401, { error: 'Unauthorized' })
    return json(res, 200, presenceList())
  }

  // ---- Demo controls (mock only) -----------------------------------------
  switch (route) {
    case 'GET /mock/state':
      return json(res, 200, {
        instanceId: INSTANCE_ID,
        chaos,
        simulator: { running: sim.running, intervalMs: sim.intervalMs },
        tablesTotal: tables.length,
        tablesReported: totals.get('department')?.tablesReported ?? 0,
        doubtfulCases: cases.size,
      })
    case 'POST /mock/redis': {
      const body = (await readJson(req)) ?? {}
      chaos.redisDown = body.up === false
      return json(res, 200, chaos)
    }
    case 'POST /mock/chaos': {
      const body = (await readJson(req)) ?? {}
      if (typeof body.dropResponseRate === 'number') chaos.dropResponseRate = Math.max(0, Math.min(1, body.dropResponseRate))
      return json(res, 200, chaos)
    }
    case 'POST /mock/sim': {
      const body = (await readJson(req)) ?? {}
      if (typeof body.running === 'boolean') sim.running = body.running
      if (typeof body.intervalMs === 'number' && body.intervalMs >= 20) sim.intervalMs = body.intervalMs
      restartSimulator()
      return json(res, 200, { running: sim.running, intervalMs: sim.intervalMs })
    }
    case 'POST /mock/kill':
      killAllConnections()
      return json(res, 200, { killed: true })
    case 'POST /mock/reset':
      resetState()
      killAllConnections()
      return json(res, 200, { reset: true })
    default:
      return json(res, 404, { error: 'Not found' })
  }
})

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost')
  const session = sessionFrom(url.searchParams.get('token'))
  const target =
    url.pathname === '/ws/verification' ? verificationWss : url.pathname === '/ws/juries' ? juriesWss : null
  if (!target) return socket.destroy()
  target.handleUpgrade(req, socket, head, (ws) => {
    const allowed =
      session && (target === juriesWss ? session.role === 'JURY' : session.role === 'AUDITOR' || session.role === 'COORDINATOR')
    if (!allowed) return ws.close(4401, 'Unauthorized')
    target.emit('connection', ws, req, session)
  })
})

setInterval(flushWindow, WINDOW_MS)
restartSimulator()

server.listen(PORT, () => {
  console.log(`Mock backend ${INSTANCE_ID} on http://localhost:${PORT}${API}`)
  console.log('  Users: jury1, jury2, auditor1, auditor2, coordinator1 (password pass123)')
  console.log(`  ${tables.length} tables · window ${WINDOW_MS} ms · lock TTL ${LOCK_TTL_MS} ms`)
})
