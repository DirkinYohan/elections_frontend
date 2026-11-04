import type { Catalog, Candidate, Topic } from '@shared/contracts/messages'
import { SPECIAL_LABELS } from '@shared/api/catalog'
import { candidateColor, formatInt, formatPct, formatTime } from '@shared/ui/candidates'
import type { ConnectionStatus } from '@shared/transport/status'
import { rankCandidates, reportedPct, type ResultsState } from './state'

type Attrs = Record<string, string>

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') el.className = value
    else el.setAttribute(key, value)
  }
  el.append(...children)
  return el
}

/** Writes only when the text changed: avoids layout work on every tick (INP, RT-9). */
function setText(el: Element, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

interface CandidateRow {
  root: HTMLElement
  votes: HTMLElement
  pct: HTMLElement
  bar: HTMLElement
  lastVotes: number
}

export interface ViewRefs {
  root: HTMLElement
  status: HTMLElement
  picker: HTMLElement
  title: HTMLElement
  progressFill: HTMLElement
  progressPct: HTMLElement
  progressText: HTMLElement
  updated: HTMLElement
  list: HTMLElement
  specials: HTMLElement
  corrections: HTMLElement
  correctionsCard: HTMLElement
  footer: HTMLElement
  live: HTMLElement
  debug: HTMLElement
}

const STATUS_TEXT: Record<ConnectionStatus, [string, string]> = {
  connecting: ['Conectando…', 'badge-neutral'],
  open: ['En vivo', 'badge-ok'],
  reconnecting: ['Reconectando…', 'badge-warn'],
  closed: ['Desconectado', 'badge-bad'],
}

export function buildView(container: HTMLElement): ViewRefs {
  const status = h('span', { class: 'badge badge-neutral', role: 'status' }, 'Conectando…')
  const header = h(
    'header',
    { class: 'app-header' },
    h('div', { class: 'brand' }, h('strong', {}, 'Preconteo electoral'), h('small', { 'data-dept': '' }, 'Resultados en tiempo real')),
    status,
  )

  const picker = h('div', { class: 'picker' })
  const title = h('h1', { class: 'topic-title' }, 'Departamento')
  const progressFill = h('div', { class: 'progress-fill' })
  const progressPct = h('strong', { class: 'num big' }, '0,0 %')
  const progressText = h('span', { class: 'muted num' }, '')
  const updated = h('span', { class: 'muted' }, '')
  const summary = h(
    'section',
    { class: 'card summary', 'aria-labelledby': 'topic-title' },
    title,
    h('div', { class: 'progress-line' }, h('div', {}, progressPct, h('span', { class: 'muted' }, ' de mesas informadas')), updated),
    h('div', { class: 'progress', role: 'presentation' }, progressFill),
    progressText,
  )
  title.id = 'topic-title'

  const list = h('ol', { class: 'candidates', 'aria-label': 'Votos por candidato' })
  const specials = h('dl', { class: 'specials' })
  const corrections = h('ul', { class: 'corrections' })
  const correctionsCard = h(
    'section',
    { class: 'card corrections-card', hidden: '' },
    h('h2', {}, 'Correcciones recientes'),
    h('p', { class: 'muted small' }, 'Cuando un acta se corrige, sus votos anteriores se restan y se suman los nuevos. Por eso un número puede bajar.'),
    corrections,
  )
  const footer = h('footer', { class: 'muted small foot' })
  const live = h('div', { class: 'sr-only', 'aria-live': 'polite' })
  const debug = h('section', { class: 'card debug', hidden: '' })

  const main = h(
    'main',
    { class: 'app-main stack' },
    h('p', { class: 'notice notice-info disclaimer' }, 'Preconteo informativo. El resultado oficial es el escrutinio de las actas físicas.'),
    picker,
    summary,
    h('section', { class: 'card' }, h('h2', { class: 'sr-only' }, 'Candidatos'), list, specials),
    correctionsCard,
    debug,
    footer,
  )
  container.replaceChildren(header, main, live)
  return { root: container, status, picker, title, progressFill, progressPct, progressText, updated, list, specials, corrections, correctionsCard, footer, live, debug }
}

export function renderStatus(refs: ViewRefs, status: ConnectionStatus, detail = ''): void {
  const [text, tone] = STATUS_TEXT[status]
  setText(refs.status, detail ? `${text} ${detail}` : text)
  refs.status.className = `badge ${tone}`
}

const rows = new Map<string, CandidateRow>()

function candidateRow(candidate: Candidate, candidates: readonly Candidate[]): CandidateRow {
  const existing = rows.get(candidate.key)
  if (existing) return existing
  const color = candidateColor(candidate.key, candidates)
  const votes = h('span', { class: 'votes num' }, '0')
  const pct = h('span', { class: 'pct num' }, '0,0 %')
  const bar = h('div', { class: 'bar-fill' })
  bar.style.background = color
  const swatch = h('span', { class: 'swatch', 'aria-hidden': 'true' })
  swatch.style.background = color
  const root = h(
    'li',
    { class: 'candidate' },
    h('div', { class: 'candidate-head' }, swatch, h('div', { class: 'who' }, h('strong', {}, candidate.name), h('span', { class: 'muted small' }, candidate.party)), h('div', { class: 'nums' }, votes, pct)),
    h('div', { class: 'bar' }, bar),
  )
  const row = { root, votes, pct, bar, lastVotes: -1 }
  rows.set(candidate.key, row)
  return row
}

export function topicName(topic: Topic, catalog: Catalog | null): string {
  if (topic === 'department') return catalog?.department ?? 'Departamento'
  const [kind, raw] = topic.split(':')
  const id = Number(raw)
  if (kind === 'municipality') {
    const m = catalog?.municipalities.find((x) => x.id === id)
    return m ? `Municipio de ${m.name}` : `Municipio ${id}`
  }
  for (const m of catalog?.municipalities ?? []) {
    const s = m.stations.find((x) => x.id === id)
    if (s) return `Puesto ${s.name}`
  }
  return `Puesto ${id}`
}

let lastAnnounce = 0

export function renderState(refs: ViewRefs, state: ResultsState, catalog: Catalog | null, candidates: readonly Candidate[], footer: string): void {
  setText(refs.title, topicName(state.topic, catalog))
  setText(refs.footer, footer)
  const totals = state.totals
  if (!totals) {
    setText(refs.progressText, 'Esperando datos…')
    return
  }

  const pct = reportedPct(totals)
  setText(refs.progressPct, formatPct(pct))
  setText(refs.progressText, `${formatInt(totals.tablesReported)} de ${formatInt(totals.tablesTotal)} mesas`)
  refs.progressFill.style.transform = `scaleX(${Math.min(1, pct / 100)})`
  setText(refs.updated, state.updatedAt ? `Actualizado ${formatTime(state.updatedAt)}` : '')

  // Rows are created once; ranking changes only move them with CSS `order` (no DOM reflow of the list).
  const ranked = rankCandidates(totals, candidates.map((c) => c.key))
  ranked.forEach((r, index) => {
    const candidate = candidates.find((c) => c.key === r.key)
    if (!candidate) return
    const row = candidateRow(candidate, candidates)
    if (!row.root.isConnected) refs.list.append(row.root)
    row.root.style.order = String(index)
    if (row.lastVotes >= 0 && r.votes < row.lastVotes) {
      row.root.classList.remove('down')
      void row.root.offsetWidth
      row.root.classList.add('down')
    }
    row.lastVotes = r.votes
    setText(row.votes, formatInt(r.votes))
    setText(row.pct, formatPct(r.pct))
    row.bar.style.transform = `scaleX(${r.pct / 100})`
  })

  const special = (['BLANCO', 'NULO', 'NO_MARCADO'] as const).map((key) => [SPECIAL_LABELS[key], totals.votes[key] ?? 0] as const)
  const total = Object.values(totals.votes).reduce((a, b) => a + b, 0)
  const pairs = [...special, ['Total de votantes', total] as const]
  if (refs.specials.childElementCount !== pairs.length * 2) {
    refs.specials.replaceChildren(...pairs.flatMap(([label]) => [h('dt', {}, label), h('dd', { class: 'num' }, '0')]))
  }
  pairs.forEach(([, value], i) => setText(refs.specials.children[i * 2 + 1], formatInt(value)))

  renderCorrections(refs, state, candidates)

  // Screen readers: one calm summary every 30 s at most, not every tick.
  const now = Date.now()
  if (now - lastAnnounce > 30_000 && ranked[0]) {
    lastAnnounce = now
    const leader = candidates.find((c) => c.key === ranked[0].key)?.name ?? ranked[0].key
    setText(refs.live, `${formatPct(pct)} de mesas informadas. Lidera ${leader} con ${formatInt(ranked[0].votes)} votos.`)
  }
}

let renderedCorrections: unknown = null

function renderCorrections(refs: ViewRefs, state: ResultsState, candidates: readonly Candidate[]): void {
  if (state.corrections === renderedCorrections) return
  renderedCorrections = state.corrections
  refs.correctionsCard.hidden = state.corrections.length === 0
  refs.corrections.replaceChildren(
    ...state.corrections.map((entry) => {
      const actas = entry.corrections.map((c) => `${c.ballotId} (versión ${c.fromVersion} → ${c.toVersion})`).join(', ')
      const down = entry.decreased
        .map((key) => (key === 'tablesReported' ? 'mesas informadas' : candidates.find((c) => c.key === key)?.name ?? SPECIAL_LABELS[key as keyof typeof SPECIAL_LABELS] ?? key))
        .join(', ')
      return h(
        'li',
        {},
        h('span', { class: 'num muted' }, formatTime(entry.at)),
        ' ',
        h('strong', {}, `Acta corregida: ${actas}.`),
        down ? ` Bajaron: ${down}.` : '',
        entry.corrections[0]?.reason ? h('span', { class: 'muted' }, ` ${entry.corrections[0].reason}.`) : '',
      )
    }),
  )
}

export function renderDebug(refs: ViewRefs, rowsData: [string, string][]): void {
  refs.debug.hidden = false
  if (refs.debug.childElementCount === 0) {
    refs.debug.append(h('h2', {}, 'Depuración'), h('dl', { class: 'debug-grid' }))
  }
  const grid = refs.debug.lastElementChild as HTMLElement
  if (grid.childElementCount !== rowsData.length * 2) {
    grid.replaceChildren(...rowsData.flatMap(([label]) => [h('dt', {}, label), h('dd', { class: 'num mono' }, '')]))
  }
  rowsData.forEach(([, value], i) => setText(grid.children[i * 2 + 1], value))
}

export { h }
