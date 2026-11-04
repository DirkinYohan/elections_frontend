export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'closed'

export interface StatusInfo {
  /** Consecutive failed attempts since the last successful connection. */
  attempt: number
  /** Wait before the next attempt, when status is 'reconnecting'. */
  delayMs?: number
  /** WebSocket close code, when known. */
  code?: number
}

export type StatusListener = (status: ConnectionStatus, info: StatusInfo) => void
