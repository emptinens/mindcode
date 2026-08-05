import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

export const DEFAULT_THRESHOLD = 0.85

// This is intentionally an explicit file allowlist.  Repo-wide generated
// diagnostics and unrelated legacy modules are not part of this gate.
export const ALLOWLISTED_TARGET_FILES = Object.freeze([
  'src/utils/swarm/concurrencyPolicy.ts',
  'src/utils/swarm/lifecyclePolicy.ts',
  'src/utils/swarm/spawnPolicy.ts',
  // Orchestration adapters are intentionally excluded: changed behavior is
  // exercised through extracted workerLifecycle/workerTeamReport/concurrency tests.
  'src/utils/swarm/workerTeamReport.ts',
  'src/utils/effort.ts',
  'src/utils/effortCore.ts',
  'src/utils/context.ts',
  'src/services/compact/autoCompactPolicy.ts',
  'src/services/compact/compactWarningState.ts',
  'src/services/compact/compactWatchdog.ts',
  'src/tasks/graph/taskGraph.ts',
  'src/tasks/graph/types.ts',
  'src/tasks/validation/overlap.ts',
  'src/tasks/validation/targets.ts',
  'src/utils/taskGraphAdapter.ts',
  'src/tools/AgentTool/workerReport.ts',
  'src/tools/AgentTool/workerLifecycle.ts',
  'src/services/api/vexzy/auth.ts',
  'src/services/api/vexzy/errors.ts',
  'src/services/api/vexzy/messagesClient.ts',
  'src/services/api/vexzy/messagesProtocol.ts',
  'src/services/api/vexzy/modelCatalog.ts',
  'src/services/api/vexzy/modelClient.ts',
  'src/services/api/vexzy/modelRegistry.ts',
  // Type-only protocol declarations have no runtime LCOV record; extracted
  // protocol/message-client tests cover their structural contract.
  'src/services/api/vexzy/sdkAdapter.ts',
  'src/commands/copy/copyLogic.ts',
  'src/commands/copycon/generator.ts',
  'src/commands/copycon/source.ts',
  'src/commands/status/report.ts',
  'src/utils/plugins/mindcodePluginPolicy.ts',
  'src/utils/plugins/pluginPolicy.ts',
])

function normalizePath(value, root = ROOT) {
  let normalized = String(value).trim().replaceAll('\\', '/')
  const normalizedRoot = resolve(root).replaceAll('\\', '/')

  if (normalized.startsWith(`${normalizedRoot}/`)) {
    normalized = normalized.slice(normalizedRoot.length + 1)
  } else if (isAbsolute(normalized)) {
    normalized = relative(root, normalized).replaceAll('\\', '/')
  }

  normalized = normalized.replace(/^\.\//u, '')
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new Error(`LCOV source escapes repository root: ${value}`)
  }
  return normalized
}

function finishRecord(record) {
  if (!record) return null
  const lineHits = [...record.lines.values()]
  const executableLines = record.lineFound ?? lineHits.length
  const coveredLines = record.lineHit ?? lineHits.filter(hit => hit > 0).length
  return {
    file: record.file,
    lines: record.lines,
    lineFound: executableLines,
    lineHit: coveredLines,
  }
}

export function parseLcov(text, { root = ROOT } = {}) {
  const records = new Map()
  let current = null

  const commit = () => {
    const finished = finishRecord(current)
    if (!finished) return

    const previous = records.get(finished.file)
    if (!previous) {
      records.set(finished.file, finished)
      return
    }

    const lines = new Map(previous.lines)
    for (const [line, hits] of finished.lines) {
      lines.set(line, (lines.get(line) ?? 0) + hits)
    }
    records.set(finished.file, {
      file: finished.file,
      lines,
      lineFound: previous.lineFound + finished.lineFound,
      lineHit: previous.lineHit + finished.lineHit,
    })
  }

  for (const rawLine of String(text).replaceAll('\r\n', '\n').split('\n')) {
    const line = rawLine.trim()
    if (line === 'end_of_record') {
      commit()
      current = null
      continue
    }

    const separator = line.indexOf(':')
    if (separator < 1) continue
    const key = line.slice(0, separator)
    const value = line.slice(separator + 1)

    if (key === 'SF') {
      if (current) commit()
      current = { file: normalizePath(value, root), lines: new Map() }
      continue
    }
    if (!current) continue

    if (key === 'DA') {
      const [lineNumber, hitCount] = value.split(',', 3)
      const parsedLine = Number.parseInt(lineNumber, 10)
      const parsedHits = Number.parseInt(hitCount, 10)
      if (Number.isInteger(parsedLine) && Number.isFinite(parsedHits)) {
        current.lines.set(parsedLine, parsedHits)
      }
    } else if (key === 'LF') {
      current.lineFound = Number.parseInt(value, 10)
    } else if (key === 'LH') {
      current.lineHit = Number.parseInt(value, 10)
    }
  }
  commit()
  return [...records.values()]
}

function coverageForRecord(record) {
  const total = record.lineFound
  const covered = record.lineHit
  return {
    file: record.file,
    total,
    covered,
    percentage: total === 0 ? 100 : (covered / total) * 100,
  }
}

export function evaluateCoverage(records, {
  targets = ALLOWLISTED_TARGET_FILES,
  threshold = DEFAULT_THRESHOLD,
} = {}) {
  if (!(threshold >= 0 && threshold <= 1)) {
    throw new Error(`Coverage threshold must be between 0 and 1, got ${threshold}`)
  }

  const byFile = new Map(records.map(record => [record.file, record]))
  const files = targets.map(file => {
    const record = byFile.get(file)
    return record
      ? coverageForRecord(record)
      : { file, total: 0, covered: 0, percentage: 0, missing: true }
  })
  const total = files.reduce((sum, file) => sum + file.total, 0)
  const covered = files.reduce((sum, file) => sum + file.covered, 0)
  const percentage = total === 0 ? 0 : (covered / total) * 100
  const missing = files.filter(file => file.missing).map(file => file.file)

  return {
    threshold,
    total,
    covered,
    percentage,
    files,
    missing,
    passed: missing.length === 0 && percentage >= threshold * 100,
    ignoredRecords: records.filter(record => !targets.includes(record.file)).map(record => record.file),
  }
}

export function formatCoverageReport(result) {
  const lines = [
    `MindCode architectural coverage: ${result.percentage.toFixed(2)}% (${result.covered}/${result.total} lines)`,
    `Required: ${(result.threshold * 100).toFixed(2)}% across ${result.files.length} allowlisted files`,
  ]
  for (const file of result.files) {
    const state = file.missing ? 'MISSING' : `${file.percentage.toFixed(2)}% (${file.covered}/${file.total})`
    lines.push(`  ${state.padEnd(24)} ${file.file}`)
  }
  if (result.ignoredRecords.length > 0) {
    lines.push(`Ignored non-allowlisted LCOV records: ${result.ignoredRecords.length}`)
  }
  if (result.missing.length > 0) {
    lines.push('Missing allowlisted LCOV records:')
    for (const file of result.missing) lines.push(`  ${file}`)
  }
  return lines.join('\n')
}

function parseArgs(argv) {
  const options = { lcov: resolve(ROOT, 'coverage/lcov.info'), threshold: DEFAULT_THRESHOLD }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--lcov') options.lcov = resolve(ROOT, argv[++index])
    else if (arg === '--threshold') options.threshold = Number(argv[++index])
    else if (arg === '--help') return null
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return options
}

export function runCoverageGate(argv = process.argv.slice(2)) {
  const options = parseArgs(argv)
  if (!options) {
    process.stdout.write('Usage: node scripts/coverage-changed.mjs [--lcov coverage/lcov.info] [--threshold 0.85]\n')
    return 0
  }
  if (!existsSync(options.lcov)) throw new Error(`LCOV file not found: ${options.lcov}`)
  const result = evaluateCoverage(parseLcov(readFileSync(options.lcov, 'utf8')), { threshold: options.threshold })
  process.stdout.write(`${formatCoverageReport(result)}\n`)
  return result.passed ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCoverageGate()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
