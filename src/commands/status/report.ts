import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  getModelRequestCount,
  getModelUsage,
  getSessionId,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalRequestCount,
  getTotalToolCount,
  getTotalToolDuration,
  getTotalWebSearchRequests,
} from "../../bootstrap/state.js";
import {
  DEFAULT_AUTO_COMPACT_PERCENTAGE,
  DEFAULT_WARNING_PERCENTAGE,
  calculateAutoCompactThreshold,
  calculateWarningThreshold,
  resolveAutoCompactPercentage,
} from "../../services/compact/autoCompactPolicy.js";
import {
  type CreditBreakdown,
  calculateVexzyCredits,
  formatVexzyCredits,
  getSessionCreditTotals,
  getSessionModelCredits,
} from "../../services/credits/accounting.js";
import { getTaskGraphDatabasePath } from "../../storage/taskGraphPaths.js";
import { getMindCodeConfigHomeDir } from "../../utils/envUtils.js";
import { getSwarmConcurrencySnapshot } from "../../utils/swarm/concurrencyPolicy.js";

const number = new Intl.NumberFormat("en-US");

export type StatusReportModel = {
  name: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  webSearchRequests: number;
  priceCreditsPerMillion: number | null;
  credits: CreditBreakdown;
};

export type StatusReportData = {
  generatedAt: Date;
  sessionId: string;
  sessionStartedAt: Date;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number | null;
  wallDurationMs: number;
  apiDurationMs: number;
  apiDurationWithoutRetriesMs: number;
  toolCount: number;
  toolDurationMs: number;
  webSearchRequests: number;
  credits: CreditBreakdown & { requests: number; modelsWithoutPrice: number };
  linesAdded: number;
  linesRemoved: number;
  models: StatusReportModel[];
  scheduler: {
    activeWorkers: number;
    queuedWorkers: number;
    activeWeight: number;
    queuedWeight: number;
    budget: number;
    availableWeight: number;
  };
  context: {
    effectiveWindow: number | null;
    warningPercent: number;
    compactPercent: number;
    warningTokens: number | null;
    compactTokens: number | null;
  };
  taskGraph: "initialized" | "not initialized";
};

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function finite(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function duration(ms: number): string {
  const value = finite(ms);
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds % 60).toFixed(1)}s`;
}

function metric(label: string, value: string, hint: string): string {
  return `<article class="metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><small>${escapeHtml(hint)}</small></article>`;
}

function bar(label: string, value: number, max: number): string {
  const safeValue = finite(value);
  const safeMax = Math.max(0, finite(max));
  return `<div class="bar-row"><div class="bar-label"><span>${escapeHtml(label)}</span><b>${escapeHtml(number.format(safeValue))}</b></div><progress value="${escapeHtml(safeValue)}" max="${escapeHtml(safeMax || 1)}">${escapeHtml(safeValue)}</progress></div>`;
}

function totalModelTokens(model: StatusReportModel): number {
  return (
    model.inputTokens +
    model.outputTokens +
    model.cacheReadTokens +
    model.cacheWriteTokens +
    (model.reasoningTokens ?? 0)
  );
}

function modelRows(models: StatusReportModel[]): string {
  if (models.length === 0) {
    return '<tr><td colspan="15" class="empty">No model activity recorded.</td></tr>';
  }
  return models
    .map(
      (model) =>
        `<tr><td class="model">${escapeHtml(model.name)}</td><td>${escapeHtml(number.format(model.requests))}</td><td>${escapeHtml(model.priceCreditsPerMillion === null ? "n/a" : number.format(model.priceCreditsPerMillion))}</td><td>${escapeHtml(number.format(model.inputTokens))}</td><td>${escapeHtml(number.format(model.outputTokens))}</td><td>${escapeHtml(number.format(model.cacheReadTokens))}</td><td>${escapeHtml(number.format(model.cacheWriteTokens))}</td><td>${escapeHtml(model.reasoningTokens === null ? "n/a" : number.format(model.reasoningTokens))}</td><td>${escapeHtml(formatVexzyCredits(model.credits.inputCredits))}</td><td>${escapeHtml(formatVexzyCredits(model.credits.cacheCredits))}</td><td>${escapeHtml(formatVexzyCredits(model.credits.reasoningCredits))}</td><td>${escapeHtml(formatVexzyCredits(model.credits.outputCredits))}</td><td>${escapeHtml(formatVexzyCredits(model.credits.totalCredits))}</td><td>${escapeHtml(number.format(model.webSearchRequests))}</td><td>${escapeHtml(number.format(totalModelTokens(model)))}</td></tr>`,
    )
    .join("");
}

function contextRows(context: StatusReportData["context"]): string {
  const effective =
    context.effectiveWindow === null
      ? "unavailable"
      : `${number.format(context.effectiveWindow)} tokens`;
  const warning =
    context.warningTokens === null
      ? `${context.warningPercent}% · unavailable`
      : `${context.warningPercent}% · ${number.format(context.warningTokens)} tokens`;
  const compact =
    context.compactTokens === null
      ? `${context.compactPercent}% · unavailable`
      : `${context.compactPercent}% · ${number.format(context.compactTokens)} tokens`;
  return `<tr><th>Effective input window</th><td>${escapeHtml(effective)}</td><th>Session context sample</th><td>not sampled</td></tr><tr><th>Warning threshold</th><td>${escapeHtml(warning)}</td><th>Auto-compact threshold</th><td>${escapeHtml(compact)}</td></tr>`;
}

function architecture(data: StatusReportData): string {
  const scheduler = data.scheduler;
  const taskGraphStatus =
    data.taskGraph === "initialized"
      ? "initialized · persisted runtime state detected"
      : "not initialized · no persisted runtime state detected";
  return `<section class="panel architecture"><h2>Runtime architecture</h2><div class="flow"><div class="node"><b>Leader</b><small>running</small></div><span class="arrow" aria-hidden="true">→</span><div class="node"><b>Weighted scheduler</b><small>${escapeHtml(`${scheduler.activeWorkers} active · ${scheduler.queuedWorkers} queued`)}</small></div><span class="arrow" aria-hidden="true">→</span><div class="node"><b>Luna workers</b><small>fixed worker model · runtime pool</small></div><span class="arrow" aria-hidden="true">→</span><div class="node"><b>Structured worker report</b><small>active · JSON-only Leader context</small></div></div><div class="architecture-foot"><span><b>Task graph</b><br>${escapeHtml(taskGraphStatus)}</span><span><b>Worker budget</b><br>${escapeHtml(`${number.format(scheduler.activeWeight)} active / ${number.format(scheduler.budget)} total weight`)}</span></div></section>`;
}

export function renderStatusHtml(data: StatusReportData): string {
  const totalTokens =
    data.inputTokens +
    data.outputTokens +
    data.cacheReadTokens +
    data.cacheWriteTokens +
    (data.reasoningTokens ?? 0);
  const retryOverhead = Math.max(
    0,
    data.apiDurationMs - data.apiDurationWithoutRetriesMs,
  );
  const cacheDenominator = data.inputTokens + data.cacheReadTokens;
  const cacheHitRate = cacheDenominator
    ? ((data.cacheReadTokens / cacheDenominator) * 100).toFixed(1)
    : "0.0";
  const maxModelTokens = Math.max(0, ...data.models.map(totalModelTokens));
  const tokenBars = [
    bar("Input", data.inputTokens, totalTokens),
    bar("Output", data.outputTokens, totalTokens),
    bar("Cache read", data.cacheReadTokens, totalTokens),
    bar("Cache write", data.cacheWriteTokens, totalTokens),
    ...(data.reasoningTokens === null
      ? []
      : [bar("Reasoning", data.reasoningTokens, totalTokens)]),
  ].join("");
  const modelBars = data.models.length
    ? data.models
        .map((model) =>
          bar(model.name, totalModelTokens(model), maxModelTokens),
        )
        .join("")
    : '<p class="empty">No model activity yet.</p>';
  const apiUtilization = data.wallDurationMs
    ? ((data.apiDurationMs / data.wallDurationMs) * 100).toFixed(1)
    : "0.0";

  const credits = data.credits;
  const creditBars = [
    bar(
      "Input credits",
      credits.inputCredits,
      Math.max(credits.totalCredits ?? 0, 1),
    ),
    bar(
      "Cache credits",
      credits.cacheCredits,
      Math.max(credits.totalCredits ?? 0, 1),
    ),
    bar(
      "Reasoning credits",
      credits.reasoningCredits,
      Math.max(credits.totalCredits ?? 0, 1),
    ),
    bar(
      "Output credits",
      credits.outputCredits,
      Math.max(credits.totalCredits ?? 0, 1),
    ),
  ].join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MindCode · Session status</title><style>
:root{color-scheme:light;--bg:#fff;--panel:#fff;--panel2:#f4f4f4;--line:#111;--text:#000;--muted:#555;--accent:#000;--shadow:0 5px 18px #0001}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.wrap{max-width:1440px;margin:auto;padding:30px}header{display:flex;justify-content:space-between;align-items:center;gap:24px;margin-bottom:22px}h1{font-size:30px;letter-spacing:-.04em;margin:0 0 4px}h2{font-size:17px;margin:0 0 16px}.subtitle,.meta,small{color:var(--muted)}.meta{text-align:right}.hero{display:flex;align-items:center;gap:16px}.sakura{width:120px;height:104px;flex:none}.sakura path,.sakura circle{stroke:#000}.sakura path{fill:none;stroke-width:3;stroke-linecap:round}.sakura circle{fill:#fff;stroke-width:1.4}.petals{position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:3}.petal{position:absolute;top:-24px;width:10px;height:6px;border:1px solid #000;border-radius:100% 0 100% 0;background:#fff;opacity:.7;animation:fall 12s linear infinite}.p1{left:14%;animation-delay:-3s}.p2{left:37%;animation-delay:-8s;animation-duration:15s}.p3{left:63%;animation-delay:-6s;animation-duration:11s}.p4{left:84%;animation-delay:-10s;animation-duration:17s}@keyframes fall{0%{transform:translate3d(0,-20px,0) rotate(0)}50%{transform:translate3d(42px,52vh,0) rotate(180deg)}100%{transform:translate3d(-28px,110vh,0) rotate(360deg)}}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}.metric,.panel{background:linear-gradient(145deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:10px;box-shadow:var(--shadow)}.metric{padding:15px;display:flex;flex-direction:column;min-height:110px}.metric span{color:var(--muted)}.metric strong{font-size:24px;margin:7px 0;color:var(--text)}.panel{padding:19px;margin-top:14px;overflow:auto}.columns{display:grid;grid-template-columns:1fr 1fr;gap:14px}.bar-row{margin:12px 0}.bar-label{display:flex;justify-content:space-between;gap:20px;margin-bottom:5px}progress{display:block;width:100%;height:9px;border:1px solid #000;border-radius:99px;overflow:hidden;background:#fff}progress::-webkit-progress-bar{background:#fff;border-radius:99px}progress::-webkit-progress-value{background:#000;border-radius:99px}progress::-moz-progress-bar{background:#000;border-radius:99px}table{width:100%;border-collapse:collapse;white-space:nowrap}th,td{padding:10px 12px;border-bottom:1px solid var(--line);text-align:right}th{color:var(--muted);font-weight:600}th:first-child,td:first-child{text-align:left}.model{max-width:360px;overflow:hidden;text-overflow:ellipsis}.empty{text-align:center!important;color:var(--muted);padding:24px}.architecture .flow{display:flex;align-items:stretch;gap:8px;overflow-x:auto;padding-bottom:5px}.node{min-width:170px;flex:1;padding:14px;background:#fff;border:1px solid #000;border-radius:8px}.node b{display:block;color:#000;margin-bottom:4px}.arrow{align-self:center;color:#000;font-size:22px}.architecture-foot{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:14px;color:var(--muted)}.architecture-foot span{padding:11px 13px;border-left:2px solid #000}.architecture-foot b{color:#000}footer{color:var(--muted);margin-top:18px;text-align:center}@media(prefers-reduced-motion:reduce){.petal{animation:none;display:none}}@media(max-width:950px){.grid{grid-template-columns:repeat(2,1fr)}.columns{grid-template-columns:1fr}.flow{min-width:760px}header{display:block}.meta{text-align:left;margin-top:12px}}@media(max-width:540px){.wrap{padding:17px}.grid{grid-template-columns:1fr}.hero{align-items:flex-start}.sakura{width:92px}}
</style></head><body><div class="petals" aria-hidden="true"><i class="petal p1"></i><i class="petal p2"></i><i class="petal p3"></i><i class="petal p4"></i></div><main class="wrap"><header><div class="hero"><svg class="sakura" viewBox="0 0 120 104" role="img" aria-label="Sakura tree"><path d="M57 101c5-22 3-39-3-55M56 67c-15-8-24-17-31-30M59 60c16-10 27-19 36-34M54 78c-9-2-17-1-26 4M61 80c11-4 21-4 31-1"/><circle cx="24" cy="29" r="9"/><circle cx="43" cy="18" r="10"/><circle cx="63" cy="24" r="11"/><circle cx="84" cy="17" r="10"/><circle cx="99" cy="31" r="8"/><circle cx="30" cy="49" r="7"/><circle cx="78" cy="45" r="8"/></svg><div><h1>MindCode</h1><div class="subtitle">Session telemetry · local HTML report</div></div></div><div class="meta">Session ${escapeHtml(data.sessionId)}<br>Started ${escapeHtml(data.sessionStartedAt.toLocaleString())}<br>Generated ${escapeHtml(data.generatedAt.toLocaleString())}</div></header>
<section class="grid">${metric("API requests", number.format(data.requestCount), data.requestCount ? `${number.format(Math.round(totalTokens / data.requestCount))} tokens/request` : "no completed requests")}${metric("Total tokens", number.format(totalTokens), `${number.format(data.inputTokens)} input · ${number.format(data.outputTokens)} output`)}${metric("Session credits", formatVexzyCredits(credits.totalCredits), credits.modelsWithoutPrice ? `${credits.modelsWithoutPrice} model price unavailable` : "VEXZY catalog pricing")}${metric("Cache hit rate", `${cacheHitRate}%`, `${number.format(data.cacheReadTokens)} read · ${number.format(data.cacheWriteTokens)} write`)}${metric("Wall duration", duration(data.wallDurationMs), data.requestCount ? `${duration(data.wallDurationMs / data.requestCount)} / request` : "0 ms")}${metric("API duration", duration(data.apiDurationMs), `${duration(retryOverhead)} retry overhead`)}${metric("Tool activity", number.format(data.toolCount), `${duration(data.toolDurationMs)} total tool time`)}${metric("Lines changed", `+${number.format(data.linesAdded)} / -${number.format(data.linesRemoved)}`, `${number.format(data.webSearchRequests)} web searches`)}</section>
<section class="columns"><article class="panel"><h2>Token composition</h2>${tokenBars}</article><article class="panel"><h2>Tokens by model</h2>${modelBars}</article></section>
<section class="panel"><h2>Credits by component</h2><p>VEXZY output price per 1M: input = price / 8 · cache = price / 40 · reasoning = price / 2 · output = price.</p>${creditBars}</section>
<section class="panel"><h2>Per-model details</h2><table><thead><tr><th>Model</th><th>Requests</th><th>Output price / 1M</th><th>Input tokens</th><th>Output tokens</th><th>Cache read</th><th>Cache write</th><th>Reasoning</th><th>Input credits</th><th>Cache credits</th><th>Reasoning credits</th><th>Output credits</th><th>Total credits</th><th>Searches</th><th>Total tokens</th></tr></thead><tbody>${modelRows(data.models)}</tbody></table></section>
<section class="panel"><h2>Runtime and context</h2><table><tbody>${contextRows(data.context)}<tr><th>API with retries</th><td>${escapeHtml(duration(data.apiDurationMs))}</td><th>API without retries</th><td>${escapeHtml(duration(data.apiDurationWithoutRetriesMs))}</td></tr><tr><th>Retry overhead</th><td>${escapeHtml(duration(retryOverhead))}</td><th>API utilization</th><td>${escapeHtml(`${apiUtilization}% of wall time`)}</td></tr><tr><th>Active worker weight</th><td>${escapeHtml(`${number.format(data.scheduler.activeWeight)} / ${number.format(data.scheduler.budget)}`)}</td><th>Queued worker weight</th><td>${escapeHtml(number.format(data.scheduler.queuedWeight))}</td></tr></tbody></table></section>
${architecture(data)}<footer>Generated locally by /status html · no external assets, scripts, or network report upload</footer></main></body></html>`;
}

function getReasoningTokens(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of [
    "reasoningTokens",
    "reasoning_tokens",
    "reasoningTokenCount",
  ]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.max(0, candidate);
    }
  }
  return null;
}

function collectContext(
  usage: Record<string, unknown>,
): StatusReportData["context"] {
  const entries = Object.values(usage);
  const contextWindow = Math.max(
    0,
    ...entries.map((item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).contextWindow === "number"
        ? ((item as Record<string, unknown>).contextWindow as number)
        : 0,
    ),
  );
  const maxOutputTokens = Math.max(
    0,
    ...entries.map((item) =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as Record<string, unknown>).maxOutputTokens === "number"
        ? ((item as Record<string, unknown>).maxOutputTokens as number)
        : 0,
    ),
  );
  const effectiveWindow =
    contextWindow > 0
      ? Math.max(0, contextWindow - Math.min(maxOutputTokens, 20_000))
      : null;
  const compactPercent = resolveAutoCompactPercentage(
    process.env.MINDCODE_AUTOCOMPACT_PCT_OVERRIDE,
    DEFAULT_AUTO_COMPACT_PERCENTAGE,
  );
  return {
    effectiveWindow,
    warningPercent: DEFAULT_WARNING_PERCENTAGE,
    compactPercent,
    warningTokens:
      effectiveWindow === null
        ? null
        : calculateWarningThreshold(effectiveWindow),
    compactTokens:
      effectiveWindow === null
        ? null
        : calculateAutoCompactThreshold(
            effectiveWindow,
            process.env.MINDCODE_AUTOCOMPACT_PCT_OVERRIDE,
          ),
  };
}

export async function generateStatusHtmlReport(): Promise<string> {
  const generatedAt = new Date();
  const usage = getModelUsage();
  const requestsByModel = getModelRequestCount();
  const sessionCreditsByModel = new Map(
    getSessionModelCredits().map((item) => [item.model, item]),
  );
  const models = Object.entries(usage)
    .map(([name, item]) => {
      const reasoningTokens = getReasoningTokens(item);
      const priceCreditsPerMillion =
        sessionCreditsByModel.get(name)?.priceCreditsPerMillion ?? null;
      const credits = calculateVexzyCredits(
        {
          inputTokens: finite(item.inputTokens),
          outputTokens: finite(item.outputTokens),
          cacheReadTokens: finite(item.cacheReadInputTokens),
          cacheWriteTokens: finite(item.cacheCreationInputTokens),
          reasoningTokens: reasoningTokens ?? 0,
        },
        priceCreditsPerMillion,
      );
      return {
        name,
        requests: requestsByModel[name] ?? 0,
        inputTokens: finite(item.inputTokens),
        outputTokens: finite(item.outputTokens),
        cacheReadTokens: finite(item.cacheReadInputTokens),
        cacheWriteTokens: finite(item.cacheCreationInputTokens),
        reasoningTokens,
        webSearchRequests: finite(item.webSearchRequests),
        priceCreditsPerMillion,
        credits,
      };
    })
    .sort((a, b) => b.requests - a.requests || a.name.localeCompare(b.name));
  const { queuedRequests, ...schedulerSnapshot } =
    getSwarmConcurrencySnapshot();
  const scheduler = {
    ...schedulerSnapshot,
    queuedWorkers: queuedRequests,
  };
  const usageRecord = usage as Record<string, unknown>;
  const credits = getSessionCreditTotals();
  const wallDurationMs = getTotalDuration();
  const data: StatusReportData = {
    generatedAt,
    sessionId: String(getSessionId()),
    sessionStartedAt: new Date(generatedAt.getTime() - wallDurationMs),
    requestCount: getTotalRequestCount(),
    inputTokens: getTotalInputTokens(),
    outputTokens: getTotalOutputTokens(),
    cacheReadTokens: getTotalCacheReadInputTokens(),
    cacheWriteTokens: getTotalCacheCreationInputTokens(),
    reasoningTokens: models.some((model) => model.reasoningTokens !== null)
      ? models.reduce((sum, model) => sum + (model.reasoningTokens ?? 0), 0)
      : null,
    wallDurationMs,
    apiDurationMs: getTotalAPIDuration(),
    apiDurationWithoutRetriesMs: getTotalAPIDurationWithoutRetries(),
    toolCount: getTotalToolCount(),
    toolDurationMs: getTotalToolDuration(),
    webSearchRequests: getTotalWebSearchRequests(),
    credits,
    linesAdded: getTotalLinesAdded(),
    linesRemoved: getTotalLinesRemoved(),
    models,
    scheduler,
    context: collectContext(usageRecord),
    taskGraph: existsSync(getTaskGraphDatabasePath())
      ? "initialized"
      : "not initialized",
  };
  const html = renderStatusHtml(data);
  const reportsDir = join(getMindCodeConfigHomeDir(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const stamp = generatedAt
    .toISOString()
    .replaceAll(":", "-")
    .replaceAll(".", "-");
  const path = join(reportsDir, `status-${stamp}.html`);
  await writeFile(path, html, "utf8");
  return path;
}
