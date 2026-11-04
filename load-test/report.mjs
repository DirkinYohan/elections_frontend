// Builds an HTML report comparing runs (e.g. with and without jitter) from the CSV files of run.mjs.
//   node load-test/report.mjs results/jitter.csv results/no-jitter.csv

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'

const files = process.argv.slice(2)
if (!files.length) {
  console.error('Uso: node load-test/report.mjs <a.csv> [b.csv ...]')
  process.exit(1)
}

const COLORS = ['#1d4ed8', '#c2410c', '#15803d', '#6d28d9']
const runs = files.map((file, i) => {
  const [header, ...lines] = readFileSync(file, 'utf8').trim().split('\n')
  const keys = header.split(',')
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, k) => [keys[k], Number(v)])))
  return { name: basename(file, '.csv'), color: COLORS[i % COLORS.length], rows }
})

function chart(title, key, unit) {
  const W = 760
  const H = 260
  const P = { l: 56, r: 16, t: 16, b: 36 }
  const maxT = Math.max(1, ...runs.flatMap((r) => r.rows.map((x) => x.t)))
  const maxV = Math.max(1, ...runs.flatMap((r) => r.rows.map((x) => x[key])))
  const x = (t) => P.l + (t / maxT) * (W - P.l - P.r)
  const y = (v) => H - P.b - (v / maxV) * (H - P.t - P.b)
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(maxV * f))
  const grid = ticks.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}" stroke="#d9dde4"/><text x="${P.l - 8}" y="${y(v) + 4}" text-anchor="end">${v}</text>`).join('')
  const lines = runs
    .map((r) => `<polyline fill="none" stroke="${r.color}" stroke-width="2" points="${r.rows.map((p) => `${x(p.t).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ')}"/>`)
    .join('')
  const legend = runs.map((r) => `<span><i style="background:${r.color}"></i>${r.name} · máx ${Math.max(0, ...r.rows.map((p) => p[key]))}${unit}</span>`).join('')
  return `<section><h2>${title}</h2><div class="legend">${legend}</div>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${grid}${lines}
<text x="${W / 2}" y="${H - 6}" text-anchor="middle">segundos</text></svg></section>`
}

const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prueba de carga · Preconteo</title><style>
body{font:15px/1.45 system-ui,sans-serif;margin:0;background:#f4f5f7;color:#14171f}main{max-width:820px;margin:0 auto;padding:24px 16px}
section{background:#fff;border:1px solid #d9dde4;border-radius:10px;padding:16px;margin-bottom:16px}h1{font-size:1.4rem}h2{font-size:1.05rem;margin:0 0 8px}
svg{width:100%;height:auto;font-size:11px;fill:#6b7280}.legend{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:6px}.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:6px;vertical-align:-1px}
</style></head><body><main><h1>Prueba de carga · reconexiones con y sin jitter (RF-10)</h1>
${chart('Reconexiones por segundo', 'reconnects', '/s')}
${chart('Intentos de conexión por segundo', 'connectAttempts', '/s')}
${chart('Conexiones SSE abiertas', 'sseOpen', '')}
${chart('Latencia p95 at → recepción', 'p95', ' ms')}
</main></body></html>`

const out = resolve(dirname(files[0]), 'report.html')
writeFileSync(out, html)
console.log(`Reporte: ${out}`)
