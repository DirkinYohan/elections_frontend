/**
 * Client-side measurements for section 7 (SSE vs polling) and RT-9 (INP).
 * Exposed on window.__metrics so the load test and the browser console can read them.
 */
export interface ClientMetrics {
  transport: 'sse' | 'polling'
  startedAt: number
  messages: number
  /** Messages that actually changed something (polling often brings no change). */
  usefulMessages: number
  bytes: number
  reconnects: number
  snapshots: number
  /** Server `at` → browser receipt, last 200 samples (ms). Includes clock skew. */
  latencies: number[]
  inp: number | null
  anomalies: number
}

export function createMetrics(transport: 'sse' | 'polling'): ClientMetrics {
  const metrics: ClientMetrics = {
    transport,
    startedAt: Date.now(),
    messages: 0,
    usefulMessages: 0,
    bytes: 0,
    reconnects: 0,
    snapshots: 0,
    latencies: [],
    inp: null,
    anomalies: 0,
  }
  ;(window as unknown as { __metrics: ClientMetrics }).__metrics = metrics
  return metrics
}

export function recordLatency(metrics: ClientMetrics, serverAt: number): void {
  metrics.latencies.push(Date.now() - serverAt)
  if (metrics.latencies.length > 200) metrics.latencies.shift()
}

export function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}
