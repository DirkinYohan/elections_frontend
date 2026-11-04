// Child process of run.mjs: holds a share of the public SSE connections.
// Each connection behaves like the real browser client: resumes with lastEventId and
// reconnects with exponential backoff, with or without full jitter (RF-10).

import http from 'node:http'
import https from 'node:https'

const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, Infinity]

let config = null
const stats = newStats()

function newStats() {
  return { connectAttempts: 0, reconnects: 0, events: 0, bytes: 0, errors: 0, latency: BUCKETS.map(() => 0) }
}

function backoff(attempt) {
  const window = Math.min(60_000, config.baseMs * 2 ** attempt)
  return config.jitter ? Math.floor(Math.random() * window) : window
}

let open = 0

function connect(client) {
  const url = new URL('/api/v1/stream', config.target)
  url.searchParams.set('topic', client.topic)
  if (client.lastId) url.searchParams.set('lastEventId', client.lastId)
  stats.connectAttempts++
  if (client.everConnected) stats.reconnects++

  const lib = url.protocol === 'https:' ? https : http
  const req = lib.get(url, { agent: false, headers: { Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) {
      res.resume()
      return retry(client)
    }
    open++
    client.everConnected = true
    client.attempt = 0
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      stats.bytes += chunk.length
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        handleFrame(client, frame)
      }
    })
    res.on('close', () => {
      open--
      retry(client)
    })
  })
  req.on('error', () => {
    stats.errors++
    retry(client)
  })
  client.req = req
}

function handleFrame(client, frame) {
  let id = null
  let data = null
  for (const line of frame.split('\n')) {
    if (line.startsWith('id:')) id = line.slice(3).trimStart()
    else if (line.startsWith('data:')) data = line.slice(5).trimStart()
  }
  if (!data) return // ": ping" comments
  if (id) client.lastId = id
  stats.events++
  try {
    const at = JSON.parse(data).at
    const ms = Date.now() - at
    stats.latency[BUCKETS.findIndex((b) => ms <= b)]++
  } catch {
    // ignore
  }
}

function retry(client) {
  if (client.retrying || config.stopping) return
  client.retrying = true
  const delay = backoff(client.attempt++)
  setTimeout(() => {
    client.retrying = false
    connect(client)
  }, delay)
}

process.on('message', (msg) => {
  if (msg.type === 'start') {
    config = msg.config
    const clients = Array.from({ length: config.connections }, (_, i) => ({
      topic: config.topics[(config.offset + i) % config.topics.length],
      lastId: null,
      attempt: 0,
      everConnected: false,
      retrying: false,
    }))
    // Ramp up: spread the initial connections so the test does not start with its own avalanche.
    const perTick = Math.max(1, Math.ceil(config.rampPerSecond / 10))
    let next = 0
    const ramp = setInterval(() => {
      for (let k = 0; k < perTick && next < clients.length; k++) connect(clients[next++])
      if (next >= clients.length) clearInterval(ramp)
    }, 100)
    setInterval(() => {
      process.send({ type: 'stats', open, ...stats })
      Object.assign(stats, newStats())
    }, 1000)
  }
  if (msg.type === 'stop') {
    config.stopping = true
    process.exit(0)
  }
})
