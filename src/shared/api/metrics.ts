import type { MetricsResponse } from '../contracts/messages'
import { getJson } from './http'

export function getMetrics(token?: string): Promise<MetricsResponse> {
  return getJson<MetricsResponse>('/metrics', { token, timeoutMs: 5000 })
}

// ---- Demo controls: only exist in the mock server ----------------------------------------

export interface MockState {
  instanceId: string
  chaos: { redisDown: boolean; dropResponseRate: number }
  simulator: { running: boolean; intervalMs: number }
  tablesTotal: number
  tablesReported: number
  doubtfulCases: number
}

export async function getMockState(): Promise<MockState | null> {
  try {
    return await getJson<MockState>('/mock/state', { timeoutMs: 3000 })
  } catch {
    return null
  }
}

export const mockControls = {
  redis: (up: boolean) => getJson('/mock/redis', { method: 'POST', body: { up } }),
  dropResponses: (rate: number) => getJson('/mock/chaos', { method: 'POST', body: { dropResponseRate: rate } }),
  simulator: (running: boolean, intervalMs?: number) =>
    getJson('/mock/sim', { method: 'POST', body: { running, intervalMs } }),
  kill: () => getJson('/mock/kill', { method: 'POST', body: {} }),
}
