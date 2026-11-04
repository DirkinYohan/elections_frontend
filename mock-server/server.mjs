// Mock of the Spring Boot backend, so the frontend can be built and demoed without it.
// It follows CONTRACT.md: POST /api/actas, SSE /api/stream and WebSocket /ws/auditor.
// Everything lives in memory: this is NOT the real system, it only imitates its behaviour.
//
// Run: npm run mock   (listens on :8080, the same port Spring uses, so the Vite proxy works unchanged)

import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT ?? 8080)
const INSTANCE_ID = `mock-${process.pid}`
const WINDOW_MS = Number(process.env.WINDOW_MS ?? 2000) // aggregation window (RF-4)
const RETENTION = Number(process.env.RETENTION ?? 300) // events kept per topic (RF-6)
const SLOW_CLIENT_BYTES = 256 * 1024 // pending output that marks a client as slow (RF-9)
const FANOUT_BATCH = 500 // connections per batch before yielding the event loop (RF-4)
const LOCK_TTL_MS = Number(process.env.LOCK_TTL_MS ?? 30_000) // auditor lock (RF-7)
const PRESENCE_TTL_MS = 25_000 // auditor without heartbeat for this long is a ghost (RF-8)
const TABLES_PER_STATION = Number(process.env.TABLES_PER_STATION ?? 10)
const VOTE_KEYS = ['C1', 'C2', 'C3', 'BLANCO', 'NULO', 'NO_MARCADO']

// ---------------------------------------------------------------------------
// Electoral model: 3 municipalities × 4 stations × N tables
// ---------------------------------------------------------------------------

const tables = [] // { mesa, puesto, municipio }
let nextMesa = 1
for (const municipio of [11, 12, 13]) {
  for (let k = 0; k < 4; k++) {
    const puesto = municipio * 10 + k
    for (let t = 0; t < TABLES_PER_STATION; t++) tables.push({ mesa: nextMesa++, puesto, municipio })
  }
}

const topicsOf = (s) => ['department', `municipality:${s.municipio}`, `station:${s.puesto}`]
const emptyVotes = () => Object.fromEntries(VOTE_KEYS.map((k) => [k, 0]))

const tablesTotal = new Map()
for (const t of tables) {
  for (const topic of topicsOf(t)) tablesTotal.set(topic, (tablesTotal.get(topic) ?? 0) + 1)
}

// ---------------------------------------------------------------------------
// State (in the real system all of this lives in Redis)
// ---------------------------------------------------------------------------

const applied = new Map() // acta -> sheet currently counted
const submissions = new Map() // `${acta}#${version}` -> response (permanent idempotency)
const idemKeys = new Map() // idem -> `${acta}#${version}`
const totals = new Map() // topic -> live totals
const published = new Map() // topic -> totals as of the last event sent
const logs = new Map() // topic -> [{ id, type, frame }] (stands in for a Redis Stream)
const dirty = new Set()
const pendingCorrections = new Map() // topic -> CorrectionInfo[]

const chaos = { redisDown: false, dropResponseRate: 0 }
const sim = { running: true, intervalMs: Number(process.env.SIM_INTERVAL_MS ?? 300), timer: null }

function totalsFor(topic) {
  let t = totals.get(topic)
  if (!t) {
    t = { votes: emptyVotes(), tablesReported: 0, tablesTotal: tablesTotal.get(topic) ?? 0 }
    totals.set(topic, t)
  }
  return t
}

const clone = (t) => ({ votes: { ...t.votes }, tablesReported: t.tablesReported, tablesTotal: t.tablesTotal })

// Monotonic ids with the same shape as Redis Stream ids: <ms>-<seq>
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
  const [am, as = '0'] = a.split('-').map(BigInt)
  const [bm, bs = '0'] = b.split('-').map(BigInt)
  if (am !== bm) return am < bm ? -1 : 1
  if (as !== bs) return as < bs ? -1 : 1
  return 0
}

// ---------------------------------------------------------------------------
// Applying tally sheets (RF-1, RF-2, RF-3)
// ---------------------------------------------------------------------------

function applySheet(sheet) {
  const prev = applied.get(sheet.acta)
  for (const topic of topicsOf(sheet)) {
    const t = totalsFor(topic)
    if (prev) {
      for (const [k, v] of Object.entries(prev.votos)) t.votes[k] = (t.votes[k] ?? 0) - v
      const list = pendingCorrections.get(topic) ?? []
      list.push({ acta: sheet.acta, fromVersion: prev.version, toVersion: sheet.version, reason: 'Acta corregida por el jurado' })
      pendingCorrections.set(topic, list)
    } else {
      t.tablesReported++
    }
    for (const [k, v] of Object.entries(sheet.votos)) t.votes[k] = (t.votes[k] ?? 0) + v
    dirty.add(topic)
  }
  applied.set(sheet.acta, sheet)
}

function validate(s) {
  if (!s || typeof s !== 'object') return 'Cuerpo vacío o no es JSON'
  if (typeof s.acta !== 'string' || !s.acta) return 'Falta "acta"'
  if (typeof s.idem !== 'string' || !s.idem) return 'Falta "idem"'
  for (const f of ['mesa', 'puesto', 'municipio', 'version', 'sufragantes']) {
    if (!Number.isInteger(s[f]) || s[f] < 0) return `"${f}" debe ser un entero no negativo`
  }
  if (s.version < 1) return '"version" empieza en 1'
  if (!s.votos || typeof s.votos !== 'object') return 'Falta "votos"'
  for (const [k, v] of Object.entries(s.votos)) {
    if (!Number.isInteger(v) || v < 0) return `Votos inválidos para ${k}`
  }
  return null
}

/** Returns [httpStatus, SubmitResponse] */
function submit(sheet) {
  if (chaos.redisDown) {
    return [503, { status: 'UNAVAILABLE', acta: sheet?.acta ?? '', version: sheet?.version ?? 0, reason: 'Sistema degradado: el acta NO quedó registrada, se reintentará' }]
  }
  const error = validate(sheet)
  if (error) return [422, { status: 'REJECTED', acta: sheet?.acta ?? '', version: sheet?.version ?? 0, reason: error }]

  const key = `${sheet.acta}#${sheet.version}`
  const knownKey = idemKeys.get(sheet.idem) ?? (submissions.has(key) ? key : null)
  if (knownKey) {
    const first = submissions.get(knownKey)
    return [200, { ...first, status: 'DUPLICATE', reason: `Ya registrada antes (${first.status})` }]
  }

  const base = { acta: sheet.acta, version: sheet.version, receipt: `R-${randomUUID().slice(0, 8)}`, registeredAt: Date.now() }
  let result
  const sum = Object.values(sheet.votos).reduce((a, b) => a + b, 0)
  const current = applied.get(sheet.acta)

  if (sum !== sheet.sufragantes) {
    result = [202, { ...base, status: 'DOUBTFUL', reason: `La suma de votos (${sum}) no coincide con sufragantes (${sheet.sufragantes})` }]
    addCase(sheet, sum)
  } else if (current && current.version >= sheet.version) {
    result = [200, { ...base, status: 'SUPERSEDED', reason: `Ya está aplicada la versión ${current.version}` }]
  } else {
    applySheet(sheet)
    result = [201, { ...base, status: 'REGISTERED' }]
  }

  submissions.set(key, result[1])
  idemKeys.set(sheet.idem, key)
  return result
}

// ---------------------------------------------------------------------------
// Aggregation window + fan-out (RF-4, RF-5, RF-9)
// ---------------------------------------------------------------------------

const subscribers = new Map() // topic -> Set<res>

function frameOf(id, type, payload) {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

function flushWindow() {
  if (chaos.redisDown) return // degraded: nothing new is published
  for (const topic of dirty) {
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
      ? { type: 'correction', topic, changes, corrections, at: Date.now() }
      : { type: 'delta', topic, changes, at: Date.now() }
    const event = { id, type: payload.type, frame: frameOf(id, payload.type, payload) }

    const log = logs.get(topic) ?? []
    log.push(event)
    if (log.length > RETENTION) log.splice(0, log.length - RETENTION) // like XADD MAXLEN
    logs.set(topic, log)
    published.set(topic, clone(cur))
    metrics.current.events++
    broadcast(topic, event.frame)
  }
  dirty.clear()
}

/** Sends one pre-serialized frame to every subscriber of a topic, in batches. */
function broadcast(topic, frame) {
  const targets = [...(subscribers.get(topic) ?? [])]
  let i = 0
  const sendBatch = () => {
    const end = Math.min(i + FANOUT_BATCH, targets.length)
    for (; i < end; i++) {
      const res = targets[i]
      if (res.writableLength > SLOW_CLIENT_BYTES) {
        // Slow client: stop feeding it. It reconnects with its lastEventId and catches up.
        metrics.current.slowDisconnects++
        res.end()
        continue
      }
      res.write(frame)
      metrics.current.messages++
    }
    if (i < targets.length) setImmediate(sendBatch) // yield to the event loop between batches
  }
  sendBatch()
}

function handleStream(req, res, url) {
  const topic = url.searchParams.get('topic') ?? 'department'
  if (!/^(department|municipality:\d+|station:\d+)$/.test(topic)) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'Tópico inválido' }))
    return
  }
  const lastId = url.searchParams.get('lastEventId') ?? req.headers['last-event-id'] ?? null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  metrics.current.sseConnects++

  const log = logs.get(topic) ?? []
  const canReplay =
    lastId &&
    /^\d+-\d+$/.test(lastId) &&
    log.length > 0 &&
    compareIds(lastId, log[0].id) >= 0 &&
    compareIds(lastId, log[log.length - 1].id) <= 0

  if (canReplay) {
    // Inside the retention window: send only what the client missed.
    for (const e of log) if (compareIds(e.id, lastId) > 0) res.write(e.frame)
  } else {
    // First connection or too far behind: full snapshot.
    const snapshotId = log.length ? log[log.length - 1].id : '0-0'
    const base = published.get(topic) ?? { votes: emptyVotes(), tablesReported: 0, tablesTotal: tablesTotal.get(topic) ?? 0 }
    const payload = { type: 'snapshot', topic, totals: clone(base), instanceId: INSTANCE_ID, at: Date.now() }
    res.write(frameOf(snapshotId, 'snapshot', payload))
  }

  let set = subscribers.get(topic)
  if (!set) subscribers.set(topic, (set = new Set()))
  set.add(res)
  req.on('close', () => set.delete(res))
}

// Comment line every 15 s so proxies and load balancers do not close idle streams.
setInterval(() => {
  for (const set of subscribers.values()) for (const res of set) res.write(': ping\n\n')
}, 15_000)

// ---------------------------------------------------------------------------
// Auditors: verification queue, locks and presence (RF-7, RF-8)
// ---------------------------------------------------------------------------

const cases = new Map() // caseId -> DoubtfulCase
const locks = new Map() // caseId -> { auditorId, token, expiresAt, since }
const auditors = new Map() // ws -> { auditorId, name, lastSeen }

function addCase(sheet, sum) {
  const item = {
    caseId: `CASE-${sheet.acta}-v${sheet.version}`,
    acta: sheet.acta,
    municipio: sheet.municipio,
    priority: Math.min(5, 1 + Math.abs(sum - sheet.sufragantes)),
    reason: `La suma de votos (${sum}) no coincide con sufragantes (${sheet.sufragantes})`,
    createdAt: Date.now(),
  }
  cases.set(item.caseId, item)
  broadcastAuditors({ type: 'case_added', item })
}

function caseView(c) {
  const lock = locks.get(c.caseId)
  return lock ? { ...c, lockedBy: lock.auditorId, lockExpiresAt: lock.expiresAt } : { ...c }
}

function presenceList() {
  return [...auditors.values()].map((a) => {
    const held = [...locks.entries()].find(([, l]) => l.auditorId === a.auditorId)
    return {
      auditorId: a.auditorId,
      name: a.name,
      caseId: held?.[0],
      caseSince: held?.[1].since,
      lastSeen: a.lastSeen,
      instanceId: INSTANCE_ID,
    }
  })
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastAuditors(msg) {
  const data = JSON.stringify(msg)
  for (const ws of auditors.keys()) if (ws.readyState === ws.OPEN) ws.send(data)
}

function announceLock(caseId, lock) {
  for (const [ws, a] of auditors) {
    send(ws, {
      type: 'case_locked',
      caseId,
      auditorId: lock.auditorId,
      lockExpiresAt: lock.expiresAt,
      ...(a.auditorId === lock.auditorId ? { lockToken: lock.token } : {}),
    })
  }
}

const ownsLock = (caseId, token) => {
  const lock = locks.get(caseId)
  return lock && lock.token === token && lock.expiresAt > Date.now()
}

function onAuditorMessage(ws, me, msg) {
  me.lastSeen = Date.now()
  switch (msg?.type) {
    case 'heartbeat': {
      if (!msg.active) return // idle auditor: the lock is NOT renewed
      for (const [caseId, lock] of locks) {
        if (lock.auditorId === me.auditorId) {
          lock.expiresAt = Date.now() + LOCK_TTL_MS
          announceLock(caseId, lock)
        }
      }
      return
    }
    case 'take_case': {
      if (!cases.has(msg.caseId)) return send(ws, { type: 'error', code: 'CASE_NOT_FOUND', message: 'El caso ya no existe' })
      const current = locks.get(msg.caseId)
      if (current && current.expiresAt > Date.now() && current.auditorId !== me.auditorId) {
        return send(ws, { type: 'take_rejected', caseId: msg.caseId, lockedBy: current.auditorId })
      }
      const holding = [...locks.entries()].find(([id, l]) => l.auditorId === me.auditorId && id !== msg.caseId)
      if (holding) {
        return send(ws, { type: 'error', code: 'ALREADY_HOLDING_CASE', message: `Ya estás trabajando en ${holding[0]}` })
      }
      const lock = current?.auditorId === me.auditorId
        ? current
        : { auditorId: me.auditorId, token: randomUUID(), expiresAt: Date.now() + LOCK_TTL_MS, since: Date.now() }
      locks.set(msg.caseId, lock)
      announceLock(msg.caseId, lock)
      broadcastAuditors({ type: 'presence', auditors: presenceList() })
      return
    }
    case 'resolve_case':
    case 'release_case': {
      if (!ownsLock(msg.caseId, msg.lockToken)) {
        // Safe release: a late auditor whose lock expired cannot free someone else's lock.
        return send(ws, { type: 'error', code: 'LOCK_NOT_OWNED', message: 'Tu bloqueo expiró o pertenece a otro auditor' })
      }
      locks.delete(msg.caseId)
      if (msg.type === 'resolve_case') {
        cases.delete(msg.caseId)
        broadcastAuditors({ type: 'case_resolved', caseId: msg.caseId, auditorId: me.auditorId, decision: msg.decision })
      } else {
        broadcastAuditors({ type: 'case_released', caseId: msg.caseId, reason: 'released' })
      }
      broadcastAuditors({ type: 'presence', auditors: presenceList() })
      return
    }
    default:
      send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'Tipo de mensaje desconocido' })
  }
}

// Expired locks go back to the queue; silent connections stop counting as present.
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const [caseId, lock] of locks) {
    if (lock.expiresAt <= now) {
      locks.delete(caseId)
      broadcastAuditors({ type: 'case_released', caseId, reason: 'expired' })
      changed = true
    }
  }
  for (const [ws, a] of auditors) {
    if (now - a.lastSeen > PRESENCE_TTL_MS) {
      auditors.delete(ws)
      ws.terminate()
      changed = true
    }
  }
  if (changed) broadcastAuditors({ type: 'presence', auditors: presenceList() })
}, 1000)

const wss = new WebSocketServer({ noServer: true })
let auditorSeq = 0

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost')
  const name = (url.searchParams.get('name') ?? 'Auditor').slice(0, 40)
  const me = { auditorId: `AUD-${++auditorSeq}`, name, lastSeen: Date.now() }
  auditors.set(ws, me)
  metrics.current.wsConnects++

  send(ws, { type: 'welcome', auditorId: me.auditorId, instanceId: INSTANCE_ID, lockTtlMs: LOCK_TTL_MS })
  send(ws, { type: 'queue_snapshot', cases: [...cases.values()].map(caseView) })
  broadcastAuditors({ type: 'presence', auditors: presenceList() })

  ws.on('message', (raw) => {
    let msg
    try {
      msg = JSON.parse(String(raw))
    } catch {
      return send(ws, { type: 'error', code: 'BAD_MESSAGE', message: 'JSON inválido' })
    }
    onAuditorMessage(ws, me, msg)
  })

  ws.on('close', () => {
    // The lock is NOT released here: it expires on its own if no active heartbeat renews it.
    auditors.delete(ws)
    broadcastAuditors({ type: 'presence', auditors: presenceList() })
  })
})

// ---------------------------------------------------------------------------
// Simulator: imitates poll workers submitting during the election night
// ---------------------------------------------------------------------------

const rand = (min, max) => min + Math.floor(Math.random() * (max - min + 1))
const sentByTable = new Map() // mesa -> last sheet the simulator sent

function makeSheet(table, version = 1) {
  const votos = { C1: rand(50, 300), C2: rand(50, 300), C3: rand(50, 300), BLANCO: rand(0, 30), NULO: rand(0, 15), NO_MARCADO: rand(0, 8) }
  const sum = Object.values(votos).reduce((a, b) => a + b, 0)
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
  if (r < 0.08 && sent.length) {
    submit(sent[rand(0, sent.length - 1)]) // resend with the same idem (bad network)
    return
  }
  if (r < 0.11 && sent.length) {
    const prev = sent[rand(0, sent.length - 1)]
    const fixed = makeSheet(prev, prev.version + 1) // correction
    fixed.sufragantes = Object.values(fixed.votos).reduce((a, b) => a + b, 0)
    sentByTable.set(prev.mesa, fixed)
    submit(fixed)
    return
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
// Metrics per second (for the operations dashboard and the RF-10 chart)
// ---------------------------------------------------------------------------

const newBucket = () => ({ t: Date.now(), sseConnects: 0, wsConnects: 0, messages: 0, events: 0, slowDisconnects: 0 })
const metrics = { current: newBucket(), history: [] }
setInterval(() => {
  let sseOpen = 0
  for (const set of subscribers.values()) sseOpen += set.size
  metrics.history.push({ ...metrics.current, sseOpen, wsOpen: auditors.size })
  if (metrics.history.length > 300) metrics.history.shift()
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
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function killAllConnections() {
  // Simulates an instance dying: every client reconnects at once (RF-10).
  for (const set of subscribers.values()) for (const res of set) res.destroy()
  for (const ws of auditors.keys()) ws.terminate()
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const route = `${req.method} ${url.pathname}`

  switch (route) {
    case 'GET /api/stream':
      return handleStream(req, res, url)

    case 'POST /api/actas': {
      const sheet = await readJson(req)
      const [status, body] = submit(sheet)
      if (status < 300 && Math.random() < chaos.dropResponseRate) {
        // Stored, but the "server dies" before confirming: the client must resend.
        return req.socket.destroy()
      }
      return json(res, status, body)
    }

    case 'GET /api/instance':
      return json(res, 200, { instanceId: INSTANCE_ID })

    // ---- Demo controls -------------------------------------------------
    case 'GET /api/mock/state':
      return json(res, 200, {
        instanceId: INSTANCE_ID,
        chaos,
        simulator: { running: sim.running, intervalMs: sim.intervalMs },
        tablesTotal: tables.length,
        tablesReported: totals.get('department')?.tablesReported ?? 0,
        doubtfulCases: cases.size,
        locks: locks.size,
        auditors: auditors.size,
      })
    case 'GET /api/mock/metrics':
      return json(res, 200, metrics.history)
    case 'POST /api/mock/redis': {
      const body = (await readJson(req)) ?? {}
      chaos.redisDown = body.up === false
      return json(res, 200, chaos)
    }
    case 'POST /api/mock/chaos': {
      const body = (await readJson(req)) ?? {}
      if (typeof body.dropResponseRate === 'number') chaos.dropResponseRate = Math.max(0, Math.min(1, body.dropResponseRate))
      return json(res, 200, chaos)
    }
    case 'POST /api/mock/sim': {
      const body = (await readJson(req)) ?? {}
      if (typeof body.running === 'boolean') sim.running = body.running
      if (typeof body.intervalMs === 'number' && body.intervalMs >= 20) sim.intervalMs = body.intervalMs
      restartSimulator()
      return json(res, 200, { running: sim.running, intervalMs: sim.intervalMs })
    }
    case 'POST /api/mock/kill':
      killAllConnections()
      return json(res, 200, { killed: true })

    default:
      return json(res, 404, { error: 'Not found' })
  }
})

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost')
  if (pathname !== '/ws/auditor') return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
})

setInterval(flushWindow, WINDOW_MS)
restartSimulator()

server.listen(PORT, () => {
  console.log(`Mock backend ${INSTANCE_ID} on http://localhost:${PORT}`)
  console.log(`  SSE        GET  /api/stream?topic=department`)
  console.log(`  Actas      POST /api/actas`)
  console.log(`  Auditors   WS   /ws/auditor?name=Ana`)
  console.log(`  Controls   GET  /api/mock/state · POST /api/mock/{redis,chaos,sim,kill}`)
})
