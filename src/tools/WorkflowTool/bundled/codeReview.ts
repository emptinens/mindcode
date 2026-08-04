// Bundled "code-review" (bughunter) workflow. Plain JS, runs in the workflow VM.
// Scope -> pipeline(per-angle Find -> dedup -> Verify) -> Synthesize.
// args: optional leading level token ('high'|'xhigh'|'max') then the review target.

export const CODE_REVIEW_SCRIPT = String.raw`
export const meta = {
  name: 'code-review',
  description: 'Adversarial code review \u2014 fan-out correctness + cleanup finders, independently verify each finding, synthesize a report.',
  whenToUse: 'When the user wants a thorough multi-agent code review of a branch, PR, or set of changes.',
  phases: [
    { title: 'Scope', detail: 'Determine diff command and changed files' },
    { title: 'Find', detail: 'Per-angle finders surface candidate issues' },
    { title: 'Verify', detail: 'Independent verifier judges each candidate' },
    { title: 'Synthesize', detail: 'Merge, rank, and report confirmed findings' },
  ],
}

const LEVEL_PARAMS = {
  high:  { correctnessAngles: 3, perAngle: 6, maxFindings: 10, sweep: false },
  xhigh: { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
  max:   { correctnessAngles: 5, perAngle: 8, maxFindings: 15, sweep: true },
}
const MAX_VERIFY = 25

const CORRECTNESS_ANGLES = [
  { label: 'logic-errors', text: 'Look for logic errors, off-by-one, wrong conditionals, and incorrect control flow.' },
  { label: 'edge-cases', text: 'Look for unhandled edge cases: null/undefined, empty inputs, boundaries, overflow.' },
  { label: 'concurrency-races', text: 'Look for race conditions, unsynchronized shared state, and ordering bugs.' },
  { label: 'error-handling', text: 'Look for swallowed errors, missing error handling, and incorrect failure modes.' },
  { label: 'security', text: 'Look for injection, unsafe deserialization, auth/authz gaps, and data exposure.' },
]
const CLEANUP_ANGLES = [
  { label: 'reuse', text: 'Look for duplicated logic that should reuse existing helpers.' },
  { label: 'dead-code', text: 'Look for dead code, unused vars, and unreachable branches.' },
  { label: 'naming', text: 'Look for misleading names and unclear APIs.' },
  { label: 'complexity', text: 'Look for needless complexity that could be simplified.' },
  { label: 'consistency', text: 'Look for deviations from the conventions noted in scope.' },
]

const SCOPE_SCHEMA = {
  type: 'object', required: ['diffCommand', 'files', 'summary'],
  properties: {
    diffCommand: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    conventions: { type: 'string' },
  },
}
const CANDIDATES_SCHEMA = {
  type: 'object', required: ['candidates'],
  properties: { candidates: { type: 'array', items: {
    type: 'object', required: ['file', 'summary', 'failure_scenario'],
    properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' } },
  } } },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict', 'evidence'],
  properties: { verdict: { enum: ['CONFIRMED', 'PLAUSIBLE', 'REFUTED'] }, evidence: { type: 'string' } },
}
const REPORT_SCHEMA = {
  type: 'object', required: ['summary', 'findings'],
  properties: {
    summary: { type: 'string' },
    findings: { type: 'array', items: {
      type: 'object', required: ['file', 'summary', 'failure_scenario', 'verdict'],
      properties: { file: { type: 'string' }, line: { type: 'number' }, summary: { type: 'string' }, failure_scenario: { type: 'string' }, verdict: { enum: ['CONFIRMED', 'PLAUSIBLE'] } },
    } },
  },
}

const RAW_ARGS = (typeof args === 'string' ? args : '').trim()
const FIRST = RAW_ARGS.split(/\s+/)[0] || ''
const FIRST_IS_LEVEL = Object.prototype.hasOwnProperty.call(LEVEL_PARAMS, FIRST)
const LEVEL = FIRST_IS_LEVEL ? FIRST : 'high'
const TARGET = FIRST_IS_LEVEL ? RAW_ARGS.slice(FIRST.length).trim() : RAW_ARGS
const P = LEVEL_PARAMS[LEVEL]

phase('Scope')
const scope = await agent(
  'Establish the scope of a code review.\n\n' +
  (TARGET
    ? 'Review target / instructions (verbatim): "' + TARGET + '". Build the matching git diff command; honor any scope restriction.\n'
    : "No explicit target \u2014 review the current branch: prefer 'git diff @{upstream}...HEAD' (fall back to 'git diff main...HEAD' or 'git diff HEAD~1').\n") +
  '\n1. Determine and run the diff command(s) to confirm a non-empty diff.\n2. List the changed files.\n3. Summarize what changed in one paragraph.\n4. Note conventions a reviewer should know.\n\nReturn diffCommand exactly as a reviewer should run it. Structured output only.',
  { label: 'scope', schema: SCOPE_SCHEMA }
)
if (!scope) return { error: 'Scope agent returned no result.' }
if (!scope.files || scope.files.length === 0) {
  return { level: LEVEL, summary: 'No changes found to review.', findings: [] }
}
log(LEVEL + ' review: ' + scope.files.length + ' changed files')

const SCOPE_BLOCK =
  '## Review scope\nDiff command: ' + scope.diffCommand + '\nChanged files (' + scope.files.length + '):\n' +
  scope.files.map(f => '  - ' + f).join('\n') + '\n\n## What changed\n' + scope.summary + '\n\n## Conventions\n' + (scope.conventions || '(none noted)') + '\n' +
  (TARGET ? '\n## User instructions (verbatim)\n' + TARGET + '\n' : '')

const FINDER_PROMPT = f =>
  '## Code-review finder \u2014 ' + f.label + '\n\n' + SCOPE_BLOCK + '\nRun the diff command above and review ONLY through the lens of your angle:\n' + f.text + '\nSurface up to ' + P.perAngle + ' candidates, each with file, line, a one-line summary, and a concrete failure_scenario. If nothing qualifies, return an empty list.\n\nStructured output only.'

const VERIFIER_PROMPT = c =>
  '## Code-review verifier\n\n' + SCOPE_BLOCK + '\n## Candidate finding\nFile: ' + c.file + (c.line != null ? ':' + c.line : '') + '\nSummary: ' + c.summary + '\nFailure scenario: ' + c.failure_scenario + '\n\nRun the diff command, read the relevant file(s), and return exactly one verdict (CONFIRMED/PLAUSIBLE/REFUTED) with evidence quoting the relevant line(s).\n\nStructured output only.'

const FINDERS = CORRECTNESS_ANGLES.slice(0, P.correctnessAngles).map(a => ({ ...a, kind: 'correctness' }))
  .concat(CLEANUP_ANGLES.map(a => ({ ...a, kind: 'cleanup' })))

phase('Find')
const finderResults = await parallel(FINDERS.map(f => () => agent(FINDER_PROMPT(f), { label: f.label, phase: 'Find', schema: CANDIDATES_SCHEMA }).then(r => {
  if (!r) return []
  log(f.label + ': ' + r.candidates.length + ' candidates')
  return r.candidates.slice(0, P.perAngle)
})))

const dedupKey = c => c.file + ':' + (c.line != null ? Math.round(c.line / 5) * 5 : c.summary.toLowerCase().slice(0, 40))
const seen = new Map()
const candidates = []
for (const list of finderResults) {
  if (!list) continue
  for (const c of list) {
    const k = dedupKey(c)
    if (seen.has(k)) continue
    if (candidates.length >= MAX_VERIFY) break
    seen.set(k, true)
    candidates.push(c)
  }
}
log('Verifying ' + candidates.length + ' deduped candidates')

phase('Verify')
const verdicts = await parallel(candidates.map(c => () => agent(VERIFIER_PROMPT(c), { label: 'verify:' + (c.file || '').split('/').pop(), phase: 'Verify', schema: VERDICT_SCHEMA }).then(v => (v && v.verdict !== 'REFUTED') ? { ...c, verdict: v.verdict, evidence: v.evidence } : null)))
const findings = verdicts.filter(Boolean).slice(0, P.maxFindings)

phase('Synthesize')
const report = await agent(
  '## Synthesizer\n\nMerge and rank these confirmed/plausible findings into a concise review report.\n\nFindings (JSON):\n' + JSON.stringify(findings) + '\n\nReturn a summary and findings (file, line, summary, failure_scenario, verdict).\n\nStructured output only.',
  { label: 'synthesize', phase: 'Synthesize', schema: REPORT_SCHEMA }
)
return report || { level: LEVEL, summary: 'Review complete.', findings }
`
