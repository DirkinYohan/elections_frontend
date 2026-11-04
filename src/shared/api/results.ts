import type { AggregateDto, Topic, Totals } from '../contracts/messages'
import { getJson } from './http'

export function isTopic(value: string): value is Topic {
  return /^(department|municipality:\d+|station:\d+)$/.test(value)
}

/** Topic → REST path of the backend's ResultsApi. */
export function topicToResultsPath(topic: Topic): string {
  if (topic === 'department') return '/results/department'
  const [kind, id] = topic.split(':')
  return kind === 'municipality' ? `/results/municipality/${id}` : `/results/station/${id}`
}

export function aggregateToTotals(dto: AggregateDto): Totals {
  return {
    votes: { ...(dto.candidateTotals ?? {}) },
    tablesReported: dto.reportedTables ?? 0,
    tablesTotal: dto.totalTables ?? 0,
  }
}

/** Polling transport: used only to compare against SSE (section 7). */
export async function fetchTotals(topic: Topic): Promise<{ totals: Totals; bytes: number }> {
  const dto = await getJson<AggregateDto>(topicToResultsPath(topic), { timeoutMs: 8000 })
  return { totals: aggregateToTotals(dto), bytes: JSON.stringify(dto).length }
}
