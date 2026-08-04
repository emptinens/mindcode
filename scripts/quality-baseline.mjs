import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import stripAnsi from 'strip-ansi'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BASELINE_DIR = resolve(ROOT, '.quality-baseline')
const BASELINE_FILE = resolve(BASELINE_DIR, 'baseline.json')

const COMMANDS = {
  typecheck: {
    command: 'tsc --noEmit',
    executable: resolve(ROOT, 'node_modules/.bin/tsc'),
    args: ['--noEmit'],
    versionArgs: ['--version'],
  },
  lint: {
    command: 'biome lint src/ --max-diagnostics=none --reporter=github',
    executable: resolve(ROOT, 'node_modules/.bin/biome'),
    args: ['lint', 'src/', '--max-diagnostics=none', '--reporter=github'],
    versionArgs: ['--version'],
  },
}

function compareStrings(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalizePath(value) {
  const root = ROOT.replaceAll('\\', '/')
  return value
    .replaceAll('\\', '/')
    .replace(/^\.\//u, '')
    .replaceAll(`${root}/`, '<repo>/')
    .replaceAll(root, '<repo>')
}

function decodeCommandValue(value) {
  return value
    .replaceAll('%25', '%')
    .replaceAll('%0D', '\r')
    .replaceAll('%0A', '\n')
    .replaceAll('%2C', ',')
    .replaceAll('%3A', ':')
}

function normalizeLines(value) {
  return stripAnsi(value)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(line => normalizePath(line).replace(/[ \t]+$/u, ''))
}

function trimDiagnostic(lines) {
  let start = 0
  let end = lines.length
  while (start < end && lines[start] === '') start++
  while (end > start && lines[end - 1] === '') end--
  return lines.slice(start, end)
}

function normalizeTypeScriptDiagnostics(output) {
  const lines = normalizeLines(output)
  const diagnostics = []
  let current = []
  const flush = () => {
    const diagnostic = trimDiagnostic(current)
    if (diagnostic.length > 0) diagnostics.push(diagnostic.join('\n'))
    current = []
  }

  for (const line of lines) {
    if (/^Found \d+ errors?\.?$/u.test(line)) continue
    if (/^(?:error|warning) TS\d+:/u.test(line) ||
        /^.+\(\d+,\d+\): (?:error|warning) TS\d+:/u.test(line) ||
        /^.+:\d+:\d+ - (?:error|warning) TS\d+:/u.test(line)) {
      flush()
      current.push(line)
      continue
    }
    if (current.length > 0 || line !== '') current.push(line)
  }
  flush()
  return diagnostics.sort(compareStrings)
}

function parseAnnotation(line) {
  const match = /^::(error|warning|notice)(?: ([^:]*))?::(.*)$/u.exec(line)
  if (!match) return null

  const properties = {}
  for (const property of (match[2] ?? '').split(',')) {
    if (!property) continue
    const separator = property.indexOf('=')
    if (separator < 1) continue
    const key = property.slice(0, separator)
    const value = decodeCommandValue(property.slice(separator + 1))
    properties[key] = key === 'file' ? normalizePath(value) : value
  }

  return JSON.stringify({
    level: match[1],
    properties: Object.fromEntries(
      Object.entries(properties).sort(([left], [right]) => compareStrings(left, right)),
    ),
    message: decodeCommandValue(match[3]),
  })
}

export function normalizeGitHubAnnotations(stdout) {
  return stdout
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n')
    .map(line => parseAnnotation(stripAnsi(line)))
    .filter(annotation => annotation !== null)
    .sort(compareStrings)
}

export function normalizeDiagnostics(kind, stdout, stderr = '') {
  return kind === 'typecheck'
    ? normalizeTypeScriptDiagnostics(`${stdout}${stderr}`)
    : normalizeGitHubAnnotations(stdout)
}

export function diagnosticsHash(diagnostics) {
  return createHash('sha256')
    .update(`${[...diagnostics].sort(compareStrings).join('\n\n')}\n`, 'utf8')
    .digest('hex')
}

export function countDiagnostics(_kind, diagnostics) {
  return diagnostics.length
}

function run(command, args) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', exitCode => resolveRun({ exitCode, stdout, stderr }))
  })
}

async function runQualityCommand(kind) {
  const specification = COMMANDS[kind]
  const versionResult = await run(specification.executable, specification.versionArgs)
  if (versionResult.exitCode !== 0) {
    throw new Error(`${specification.command} version command failed with exit ${versionResult.exitCode}`)
  }
  const version = `${versionResult.stdout}${versionResult.stderr}`.trim()
  const result = await run(specification.executable, specification.args)
  const diagnostics = normalizeDiagnostics(kind, result.stdout, result.stderr)
  return {
    command: specification.command,
    version,
    exitCode: result.exitCode,
    hash: diagnosticsHash(diagnostics),
    count: countDiagnostics(kind, diagnostics),
    diagnostics,
  }
}

function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'))
}

function baselineEntry(record) {
  return { command: record.command, version: record.version, hash: record.hash, count: record.count }
}

function writeBaseline(records) {
  mkdirSync(BASELINE_DIR, { recursive: true })
  writeFileSync(BASELINE_FILE, `${JSON.stringify({
    schemaVersion: 1,
    typecheck: baselineEntry(records.typecheck),
    lint: baselineEntry(records.lint),
  }, null, 2)}\n`)
}

function compareEntry(kind, actual, expected) {
  if (!expected) return [`${kind}: no checked-in baseline`]
  const differences = []
  for (const field of ['command', 'version', 'hash', 'count']) {
    if (actual[field] !== expected[field]) {
      differences.push(`${kind}.${field}: expected ${JSON.stringify(expected[field])}, got ${JSON.stringify(actual[field])}`)
    }
  }
  return differences
}

async function main(argv) {
  const action = argv[0]
  if (action === 'update') {
    const kinds = argv.slice(1).filter(kind => kind in COMMANDS)
    const selectedKinds = kinds.length > 0 ? kinds : Object.keys(COMMANDS)
    const records = {}
    for (const kind of selectedKinds) records[kind] = await runQualityCommand(kind)
    if (selectedKinds.length !== Object.keys(COMMANDS).length) {
      const existing = readBaseline() ?? { schemaVersion: 1 }
      for (const kind of Object.keys(COMMANDS)) {
        if (!records[kind] && existing[kind]) records[kind] = existing[kind]
      }
    }
    if (!records.typecheck || !records.lint) throw new Error('Both quality baselines are required')
    writeBaseline(records)
    for (const kind of Object.keys(COMMANDS)) {
      const record = records[kind]
      process.stdout.write(`${kind}: ${record.count} diagnostics, ${record.hash}\n`)
    }
    return 0
  }
  if (!(action in COMMANDS)) {
    process.stderr.write('Usage: quality-baseline.mjs <typecheck|lint|update> [typecheck|lint]\n')
    return 2
  }

  const actual = await runQualityCommand(action)
  const differences = compareEntry(action, actual, readBaseline()?.[action])
  if (differences.length > 0) {
    process.stderr.write(`${differences.join('\n')}\nRun bun run quality-baseline:update to approve the current diagnostics.\n`)
    return 1
  }
  process.stdout.write(`${action}: ${actual.count} diagnostics, baseline ${actual.hash}\n`)
  return 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2))
    .then(exitCode => { process.exitCode = exitCode })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
