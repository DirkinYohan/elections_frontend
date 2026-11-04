import { backoffDelay, type BackoffOptions } from './backoff'
import type { StatusListener } from './status'

export interface WsClientOptions<In> {
  /** Path or URL, e.g. '/ws/auditor?name=Ana'. http(s) is turned into ws(s). */
  url: string
  onMessage: (message: In) => void
  onStatus?: StatusListener
  backoff?: BackoffOptions
  /** Close codes after which reconnecting makes no sense (e.g. 4401 unauthorized). */
  fatalCodes?: readonly number[]
}

/**
 * Plain WebSocket client (no STOMP, no SockJS) with JSON messages and jittered reconnection.
 *
 * Messages are NOT queued while disconnected: for the auditor console, an action like
 * "take case" sent minutes later would be wrong. `send` returns false and the UI decides.
 */
export class WsClient<In, Out> {
  private readonly opts: WsClientOptions<In>
  private socket?: WebSocket
  private attempt = 0
  private timer?: ReturnType<typeof setTimeout>
  private stopped = true

  constructor(opts: WsClientOptions<In>) {
    this.opts = opts
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN
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
    this.socket?.close(1000)
    this.socket = undefined
    this.opts.onStatus?.('closed', { attempt: this.attempt })
  }

  send(message: Out): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false
    this.socket.send(JSON.stringify(message))
    return true
  }

  private buildUrl(): string {
    const url = new URL(this.opts.url, location.href)
    if (url.protocol === 'http:') url.protocol = 'ws:'
    if (url.protocol === 'https:') url.protocol = 'wss:'
    return url.toString()
  }

  private open(): void {
    if (this.attempt === 0) this.opts.onStatus?.('connecting', { attempt: 0 })

    const socket = new WebSocket(this.buildUrl())
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      this.opts.onStatus?.('open', { attempt: 0 })
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      try {
        this.opts.onMessage(JSON.parse(event.data) as In)
      } catch {
        // Malformed frame: ignore it rather than breaking the console.
      }
    }

    // 'error' is always followed by 'close', so all the logic lives in onclose.
    socket.onclose = (event) => {
      if (this.socket !== socket) return
      this.socket = undefined
      if (this.stopped) return
      if (this.opts.fatalCodes?.includes(event.code)) {
        this.stopped = true
        this.opts.onStatus?.('closed', { attempt: this.attempt, code: event.code })
        return
      }
      this.scheduleReconnect(event.code)
    }
  }

  private scheduleReconnect(code: number): void {
    const delayMs = backoffDelay(this.attempt, this.opts.backoff)
    this.attempt++
    this.opts.onStatus?.('reconnecting', { attempt: this.attempt, delayMs, code })
    this.timer = setTimeout(() => this.open(), delayMs)
  }
}
