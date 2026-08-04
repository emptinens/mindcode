import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  getModelRequestCount,
  getModelUsage,
  getSessionId,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalRequestCount,
  getTotalToolCount,
  getTotalToolDuration,
  getTotalWebSearchRequests,
} from '../../bootstrap/state.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'

const number = new Intl.NumberFormat('en-US')
const money = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 4,
  maximumFractionDigits: 6,
})

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(2)} s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${(seconds % 60).toFixed(1)}s`
}

function metric(label: string, value: string, hint: string): string {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></article>`
}

function bar(label: string, value: number, max: number, formatted: string): string {
  const width = max > 0 ? Math.max(2, (value / max) * 100) : 0
  return `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(label)}</span><b>${escapeHtml(formatted)}</b></div><div class="track"><i style="width:${width.toFixed(2)}%"></i></div></div>`
}

export async function generateStatusHtmlReport(): Promise<string> {
  const generatedAt = new Date()
  const usage = getModelUsage()
  const requestsByModel = getModelRequestCount()
  const models = Object.entries(usage).sort(
    ([a], [b]) => (requestsByModel[b] ?? 0) - (requestsByModel[a] ?? 0),
  )
  const requestCount = getTotalRequestCount()
  const input = getTotalInputTokens()
  const output = getTotalOutputTokens()
  const cacheRead = getTotalCacheReadInputTokens()
  const cacheWrite = getTotalCacheCreationInputTokens()
  const totalTokens = input + output + cacheRead + cacheWrite
  const wall = getTotalDuration()
  const api = getTotalAPIDuration()
  const apiWithoutRetries = getTotalAPIDurationWithoutRetries()
  const retries = Math.max(0, api - apiWithoutRetries)
  const toolDuration = getTotalToolDuration()
  const cost = getTotalCostUSD()
  const cacheDenominator = input + cacheRead
  const cacheHitRate = cacheDenominator
    ? `${((cacheRead / cacheDenominator) * 100).toFixed(1)}%`
    : '0.0%'
  const maxModelTokens = Math.max(
    0,
    ...models.map(([, item]) =>
      item.inputTokens +
      item.outputTokens +
      item.cacheReadInputTokens +
      item.cacheCreationInputTokens,
    ),
  )

  const modelRows = models.length
    ? models
        .map(([model, item]) => {
          const total =
            item.inputTokens +
            item.outputTokens +
            item.cacheReadInputTokens +
            item.cacheCreationInputTokens
          return `<tr><td class="model">${escapeHtml(model)}</td><td>${number.format(requestsByModel[model] ?? 0)}</td><td>${number.format(item.inputTokens)}</td><td>${number.format(item.outputTokens)}</td><td>${number.format(item.cacheReadInputTokens)}</td><td>${number.format(item.cacheCreationInputTokens)}</td><td>${number.format(item.webSearchRequests)}</td><td>${number.format(total)}</td><td>${money.format(item.costUSD)}</td></tr>`
        })
        .join('')
    : '<tr><td colspan="9" class="empty">No API usage recorded in this session.</td></tr>'

  const tokenBars = [
    bar('Input', input, totalTokens, number.format(input)),
    bar('Output', output, totalTokens, number.format(output)),
    bar('Cache read', cacheRead, totalTokens, number.format(cacheRead)),
    bar('Cache write', cacheWrite, totalTokens, number.format(cacheWrite)),
  ].join('')
  const modelBars = models.length
    ? models
        .map(([model, item]) => {
          const total =
            item.inputTokens +
            item.outputTokens +
            item.cacheReadInputTokens +
            item.cacheCreationInputTokens
          return bar(model, total, maxModelTokens, number.format(total))
        })
        .join('')
    : '<p class="empty">No model activity yet.</p>'

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Code Session Status</title><style>
:root{color-scheme:dark;--bg:#09090b;--panel:#141418;--line:#2a2a31;--text:#f4f4f5;--muted:#a1a1aa;--accent:#f97316;--accent2:#fb923c}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top right,#29170e 0,transparent 33%),var(--bg);color:var(--text);font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{max-width:1400px;margin:auto;padding:34px}header{display:flex;justify-content:space-between;align-items:flex-end;gap:24px;margin-bottom:24px}h1{font-size:29px;margin:0 0 5px}h2{font-size:17px;margin:0 0 16px}.subtitle,.meta,small{color:var(--muted)}.meta{text-align:right}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel{background:linear-gradient(145deg,#17171c,#111115);border:1px solid var(--line);border-radius:14px}.metric{padding:16px;display:flex;flex-direction:column;min-height:112px}.metric span{color:var(--muted)}.metric strong{font-size:25px;margin:7px 0}.panel{padding:20px;margin-top:14px;overflow:auto}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.bar-row{margin:12px 0}.bar-label{display:flex;justify-content:space-between;gap:20px;margin-bottom:5px}.track{height:9px;border-radius:99px;background:#25252b;overflow:hidden}.track i{display:block;height:100%;border-radius:99px;background:linear-gradient(90deg,var(--accent),var(--accent2))}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:11px 13px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);font-weight:600}th:first-child,td:first-child{text-align:left}.model{max-width:360px;overflow:hidden;text-overflow:ellipsis}.empty{text-align:center!important;color:var(--muted);padding:25px}footer{color:var(--muted);margin-top:18px;text-align:center}@media(max-width:900px){.grid{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}header{display:block}.meta{text-align:left;margin-top:12px}}@media(max-width:520px){.wrap{padding:18px}.grid{grid-template-columns:1fr}}
</style></head><body><main class="wrap"><header><div><h1>Session telemetry</h1><div class="subtitle">Detailed Claude Code runtime statistics</div></div><div class="meta">Session ${escapeHtml(getSessionId())}<br>${escapeHtml(generatedAt.toLocaleString())}</div></header>
<section class="grid">
${metric('API requests', number.format(requestCount), requestCount ? `${number.format(Math.round(totalTokens / requestCount))} tokens/request` : 'no completed requests')}
${metric('Total tokens', number.format(totalTokens), `${number.format(input)} input · ${number.format(output)} output`)}
${metric('Session cost', money.format(cost), requestCount ? `${money.format(cost / requestCount)} / request` : 'no billable requests')}
${metric('Cache hit rate', cacheHitRate, `${number.format(cacheRead)} read · ${number.format(cacheWrite)} write`)}
${metric('Wall duration', duration(wall), `${requestCount ? duration(wall / requestCount) : '0 ms'} / request`)}
${metric('API duration', duration(api), `${duration(retries)} retries/overhead`)}
${metric('Tool activity', number.format(getTotalToolCount()), `${duration(toolDuration)} total tool time`)}
${metric('Web searches', number.format(getTotalWebSearchRequests()), `${number.format(getTotalLinesAdded())} lines + · ${number.format(getTotalLinesRemoved())} lines −`)}
</section>
<section class="columns"><article class="panel"><h2>Token composition</h2>${tokenBars}</article><article class="panel"><h2>Tokens by model</h2>${modelBars}</article></section>
<section class="panel"><h2>Per-model details</h2><table><thead><tr><th>Model</th><th>Requests</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Searches</th><th>Total</th><th>Cost</th></tr></thead><tbody>${modelRows}</tbody></table></section>
<section class="panel"><h2>Timing details</h2><table><tbody><tr><th>Wall clock</th><td>${duration(wall)}</td><th>API with retries</th><td>${duration(api)}</td></tr><tr><th>API without retries</th><td>${duration(apiWithoutRetries)}</td><th>Retry/overhead</th><td>${duration(retries)}</td></tr><tr><th>Tool duration</th><td>${duration(toolDuration)}</td><th>API utilization</th><td>${wall ? ((api / wall) * 100).toFixed(1) : '0.0'}%</td></tr></tbody></table></section>
<footer>Generated locally by /status html · no report data was uploaded</footer></main></body></html>`

  const reportsDir = join(getClaudeConfigHomeDir(), 'reports')
  await mkdir(reportsDir, { recursive: true })
  const stamp = generatedAt.toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const path = join(reportsDir, `status-${stamp}.html`)
  await writeFile(path, html, 'utf8')
  return path
}
