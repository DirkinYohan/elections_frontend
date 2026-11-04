import { backoffDelay, type BackoffOptions } from './backoff'
import type { StatusListener } from './status'
import { compareStreamIds, isValidStreamId } from './stream-id'

export interface SseClientOptions<T> {
  /** Endpoint, e.g. '/api/stream'. */
  url: string
  /** Query params, e.g. { topic: 'municipality:11' }. */
  params?: Record<string, string>
  /** Named SSE events to listen to (the `event:` field). */
  eventTypes: readonly string[]
  /** Event types that reset the state (they are applied even if their id is not newer). */
  resetTypes?: readonly string[]
  onEvent: (type: string, data: T, id: string) => void
  onStatus?: StatusListener
  backoff?: BackoffOptions
}

/**
 * EventSource wrapper with resumable reconnection (RF-6) and jittered backoff (RF-10).
 *
 * Why not let the browser reconnect on its own: EventSource retries at a fixed interval,
 * so every client that lost the same instance comes back at the same instant.
 * We close it on error and reopen it ourselves, sending the last processed id as
 * `?lastEventId=` (a manually reopened EventSource does not send the Last-Event-ID header).
 */
export class SseClient<T = unknown> {
  private readonly opts: SseClientOptions<T>
  private source?: EventSource
  private lastEventId?: string
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true

  constructor(opts: SseClientOptions<T>) {
    this.opts = opts
  }

  /** Last processed event id (the continuity token the client carries). */
  get lastId(): string | undefined {
    return this.lastEventId
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempt = 0
    this.open()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.source?.close()
    this.source = undefined
    this.opts.onStatus?.('closed', { attempt: this.attempt })
  }

  /** Switch topic. A different topic has a different stream, so continuity starts over. */
  resubscribe(params: Record<string, string>): void {
    this.opts.params = params
    this.lastEventId = undefined
    clearTimeout(this.timer)
    this.source?.close()
    this.source = undefined
    this.attempt = 0
    if (!this.stopped) this.open()
  }

  private buildUrl(): string {
    const url = new URL(this.opts.url, location.href)
    for (const [key, value] of Object.entries(this.opts.params ?? {})) {
      url.searchParams.set(key, value)
    }
    if (this.lastEventId) url.searchParams.set('lastEventId', this.lastEventId)
    return url.toString()
  }

  private open(): void {
    if (this.attempt === 0) this.opts.onStatus?.('connecting', { attempt: 0 })

    const source = new EventSource(this.buildUrl())
    this.source = source

    source.onopen = () => {
      this.attempt = 0
      this.opts.onStatus?.('open', { attempt: 0 })
    }

    source.onerror = () => {
      source.close()
      if (this.source !== source || this.stopped) return
      this.source = undefined
      this.scheduleReconnect()
    }

    for (const type of this.opts.eventTypes) {
      source.addEventListener(type, (event) => this.handle(type, event as MessageEvent<string>))
    }
  }

  private handle(type: string, event: MessageEvent<string>): void {
    const id = event.lastEventId
    const isReset = this.opts.resetTypes?.includes(type) ?? false

    if (id && isValidStreamId(id)) {
      // Replay overlap after a reconnection: an event we already applied. Ignore it.
      if (!isReset && this.lastEventId && compareStreamIds(id, this.lastEventId) <= 0) return
      this.lastEventId = id
    }

    let data: T
    try {
      data = JSON.parse(event.data) as T
    } catch {
      return
    }
    this.opts.onEvent(type, data, id)
  }

  private scheduleReconnect(): void {
    // Deliberately NOT reconnecting on the browser 'online' event: when the city's mobile
    // network comes back, every client would fire at the same instant (RF-10).
    const delayMs = backoffDelay(this.attempt, this.opts.backoff)
    this.attempt++
    this.opts.onStatus?.('reconnecting', { attempt: this.attempt, delayMs })
    this.timer = setTimeout(() => this.open(), delayMs)
  }
}
