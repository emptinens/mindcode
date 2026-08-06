import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import type { WorkerPolicyIdentity } from '../../services/policy/policyEpoch.js'
import type { WorkerEffort } from '../../utils/swarm/backends/types.js'
import { getConfiguredSubagentModel } from '../../utils/model/subagentModel.js'

export const WORKER_REPORT_SCHEMA_VERSION = 'worker-report/1' as const
export const WORKER_REPORT_STATUSES = [
  'completed',
  'partial',
  'blocked',
  'failed',
] as const
export const WORKER_REPORT_EFFORTS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const
export const WORKER_REPORT_EVIDENCE_TYPES = [
  'file',
  'diff',
  'command',
  'test',
  'artifact',
] as const

const MAX_ID_CHARS = 256
const MAX_SUMMARY_CHARS = 2_000
const MAX_PATH_CHARS = 4_096
const MAX_COMMAND_CHARS = 2_000
const MAX_DIGEST_CHARS = 128
const MAX_CHANGED_FILES = 256
const MAX_EVIDENCE_ITEMS = 32
const MAX_BLOCKERS = 32
const WORKER_REPORT_ID_HEX_LENGTH = 64
const WORKER_REPORT_ID_DOMAIN = 'mindcode/worker-report/1'

const boundedId = z.string().trim().min(1).max(MAX_ID_CHARS)

/**
 * Derives the runtime-owned report identity from the complete worker
 * execution identity. Length-prefixing each UTF-8 component prevents tuple
 * boundary collisions such as ["ab", "c"] vs ["a", "bc"].
 */
export function deriveWorkerReportId(
  taskId: string,
  runId: string,
  workerId: string,
): string {
  const hash = createHash('sha256').update(WORKER_REPORT_ID_DOMAIN)
  for (const value of [taskId, runId, workerId]) {
    const byteLength = Buffer.byteLength(value, 'utf8')
    hash.update(':').update(String(byteLength)).update(':').update(value)
  }
  return hash.digest('hex')
}

function isNormalizedWorkspacePath(value: string): boolean {
  if (!value || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) {
    return false
  }
  const segments = value.split('/')
  return segments.every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

const relativePath = z
  .string()
  .trim()
  .min(1)
  .max(MAX_PATH_CHARS)
  .refine(isNormalizedWorkspacePath, 'path must be workspace-relative and normalized')

export const workerEvidenceSchema = z
  .object({
    id: boundedId,
    type: z.enum(WORKER_REPORT_EVIDENCE_TYPES),
    path: relativePath.optional(),
    command: z.string().trim().min(1).max(MAX_COMMAND_CHARS).optional(),
    exit_code: z.number().int().finite().optional(),
    digest: z.string().trim().min(1).max(MAX_DIGEST_CHARS).optional(),
  })
  .strict()

export type WorkerEvidence = z.infer<typeof workerEvidenceSchema>

const workerValidationSchema = z
  .object({
    verdict: z.enum(['pass', 'fail', 'not_run']),
  })
  .strict()

const workerReportShapeSchema = z
  .object({
    schema_version: z.literal(WORKER_REPORT_SCHEMA_VERSION),
    task_id: boundedId,
    run_id: boundedId,
    worker_id: boundedId,
    report_id: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'report_id must be a lowercase SHA-256 digest'),
    model: z
      .string()
      .min(1)
      .refine(
        model => model === getConfiguredSubagentModel(),
        'model must match the configured VEXZY Worker model',
      ),
    effort_used: z.enum(WORKER_REPORT_EFFORTS),
    policy_epoch: z.number().int().nonnegative().finite(),
    policy_digest: z
      .string()
      .regex(/^[a-f0-9]{64}$/, 'policy_digest must be a lowercase SHA-256 digest'),
    status: z.enum(WORKER_REPORT_STATUSES),
    summary: z.string().trim().min(1).max(MAX_SUMMARY_CHARS),
    changed_files: z.array(relativePath).max(MAX_CHANGED_FILES),
    evidence: z.array(workerEvidenceSchema).max(MAX_EVIDENCE_ITEMS),
    tokens_used: z.number().int().nonnegative().finite(),
    validation: workerValidationSchema,
    blockers: z.array(z.string().trim().min(1).max(MAX_SUMMARY_CHARS)).max(
      MAX_BLOCKERS,
    ),
  })
  .strict()

export const workerReportSchema = workerReportShapeSchema.superRefine(
  (report, context) => {
    const expected = deriveWorkerReportId(
      report.task_id,
      report.run_id,
      report.worker_id,
    )
    if (report.report_id !== expected) {
      context.addIssue({
        code: 'custom',
        path: ['report_id'],
        message: 'report_id must match the runtime worker identity',
      })
    }
  },
)

export type WorkerReport = z.infer<typeof workerReportSchema>
export type WorkerReportStatus = WorkerReport['status']
export type WorkerReportValidationVerdict = WorkerReport['validation']['verdict']

/**
 * The model candidate is shape-checked before crossing the boundary. The
 * runtime-owned identity, usage, effort, and status fields are replaced by
 * values captured by the runtime before the report reaches the Leader.
 */
export const workerReportCandidateSchema = workerReportShapeSchema
  .omit({ report_id: true, policy_epoch: true, policy_digest: true })
  .extend({
    // The model may emit this field, but it is never trusted.
    report_id: z.unknown().optional(),
    policy_epoch: z.unknown().optional(),
    policy_digest: z.unknown().optional(),
  })
  .strict()

type WorkerReportCandidate = z.infer<typeof workerReportCandidateSchema>

export type BuildWorkerReportInput = {
  taskId: string
  status: WorkerReportStatus
  runId?: string
  workerId?: string
  model?: string
  policyEpoch?: number
  policyDigest?: string
  declaredChangedFiles?: readonly string[]
  finalText?: string
  tokensUsed: number
  effortUsed?: WorkerEffort
}

function boundedRuntimeId(value: string | undefined, fallback: string): string {
  const normalized = (value ?? fallback).trim().slice(0, MAX_ID_CHARS)
  return normalized || fallback.slice(0, MAX_ID_CHARS)
}

function normalizeWorkspacePath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) {
    return null
  }
  const withoutPrefix = normalized.replace(/^\.\//, '')
  const segments = withoutPrefix.split('/')
  if (!withoutPrefix || segments.some(segment => segment.length === 0 || segment === '..')) {
    return null
  }
  const normalizedSegments = segments.filter(segment => segment !== '.')
  return normalizedSegments.length > 0 ? normalizedSegments.join('/') : null
}

function normalizePathList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const normalized = normalizeWorkspacePath(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
    if (result.length >= limit) break
  }
  return result
}

function normalizeEvidence(value: unknown): WorkerEvidence[] | null {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ITEMS) return null
  const result: WorkerEvidence[] = []
  const seen = new Set<string>()
  for (const item of value) {
    const parsed = workerEvidenceSchema.safeParse(item)
    if (!parsed.success) return null
    const evidence = parsed.data
    const path = evidence.path
      ? normalizeWorkspacePath(evidence.path)
      : undefined
    if (evidence.path && !path) return null
    const normalized: WorkerEvidence = {
      ...evidence,
      ...(path ? { path } : {}),
    }
    const key = JSON.stringify(normalized)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(normalized)
  }
  return result
}

function normalizeCandidate(
  candidate: WorkerReportCandidate,
): WorkerReportCandidate | null {
  const changedFiles = normalizePathList(candidate.changed_files, MAX_CHANGED_FILES)
  if (changedFiles.length !== candidate.changed_files.length) return null
  const evidence = normalizeEvidence(candidate.evidence)
  if (!evidence) return null
  const parsed = workerReportCandidateSchema.safeParse({
    ...candidate,
    changed_files: changedFiles,
    evidence,
  })
  return parsed.success ? parsed.data : null
}

function stripJsonFence(value: string): string {
  const trimmed = value.trim()
  const fenced = trimmed.match(/^```json\s*([\s\S]*?)\s*```$/i)
  return fenced?.[1]?.trim() ?? trimmed
}

const WORKER_EVIDENCE_KEYS = [
  'id',
  'type',
  'path',
  'command',
  'exit_code',
  'digest',
] as const

const WORKER_REPORT_KEYS = [
  'schema_version',
  'task_id',
  'run_id',
  'worker_id',
  'report_id',
  'model',
  'effort_used',
  'policy_epoch',
  'policy_digest',
  'status',
  'summary',
  'changed_files',
  'evidence',
  'tokens_used',
  'validation',
  'blockers',
] as const

function pickKnownKeys(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    keys.flatMap(key => (key in source ? [[key, source[key]]] : [])),
  )
}

function sanitizeCandidateEvidence(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const source = item as Record<string, unknown>
    return pickKnownKeys(source, WORKER_EVIDENCE_KEYS)
  })
}

function sanitizeCandidate(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const source = value as Record<string, unknown>
  const sanitized = pickKnownKeys(source, WORKER_REPORT_KEYS)
  if ('evidence' in source) {
    sanitized.evidence = sanitizeCandidateEvidence(source.evidence)
  }
  if (
    source.validation &&
    typeof source.validation === 'object' &&
    !Array.isArray(source.validation)
  ) {
    sanitized.validation = pickKnownKeys(
      source.validation as Record<string, unknown>,
      ['verdict'],
    )
  }
  return sanitized
}

function parseCandidate(
  value: string | undefined,
): WorkerReportCandidate | null {
  if (!value?.trim()) return null
  const source = stripJsonFence(value)
  try {
    const parsed = sanitizeCandidate(JSON.parse(source))
    const candidate = workerReportCandidateSchema.safeParse(parsed)
    return candidate.success ? normalizeCandidate(candidate.data) : null
  } catch {
    // Free-form text and JSON with prose around it are deliberately invalid.
    return null
  }
}

function normalizeEffort(effort: WorkerEffort | undefined): WorkerReport['effort_used'] {
  return effort ?? 'medium'
}

function normalizeTokens(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function runtimeDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function runtimeEvidence(value: string, index: number): WorkerEvidence {
  return {
    id: `runtime-${index}-${runtimeDigest(value).slice(0, 16)}`,
    type: 'artifact',
    digest: runtimeDigest(value),
  }
}

function invalidReportSummary(status: WorkerReportStatus): string {
  return status === 'failed'
    ? 'Worker execution failed before a valid WorkerReport was produced.'
    : 'Worker returned an invalid WorkerReport; task completion was rejected.'
}

function invalidReportBlockers(status: WorkerReportStatus): string[] {
  return status === 'failed'
    ? ['worker_report_invalid', 'worker_execution_failed']
    : ['worker_report_invalid']
}

/**
 * Builds the only report shape that can cross the worker/Leader boundary.
 * Unstructured output never becomes successful evidence: a missing or
 * malformed candidate is represented as partial/failed with validation=fail.
 */
export function buildWorkerReport(input: BuildWorkerReportInput): WorkerReport {
  const taskId = boundedRuntimeId(input.taskId, 'unknown-task')
  const runId = boundedRuntimeId(input.runId, taskId)
  const workerId = boundedRuntimeId(input.workerId, runId)
  const runtimeStatus = input.status
  const candidate = parseCandidate(input.finalText)
  const candidateIsValid = candidate !== null
  const policyIdentity = resolveReportPolicyIdentity(input)
  const declaredChangedFiles = normalizePathList(
    input.declaredChangedFiles,
    MAX_CHANGED_FILES,
  )
  const changedFiles = candidateIsValid
    ? normalizePathList(
        [...declaredChangedFiles, ...candidate.changed_files],
        MAX_CHANGED_FILES,
      )
    : declaredChangedFiles

  let status: WorkerReportStatus = runtimeStatus
  if (runtimeStatus === 'completed') {
    if (!candidate) {
      status = 'partial'
    } else if (
      candidate.status === 'completed' &&
      (candidate.validation.verdict !== 'pass' || candidate.blockers.length > 0)
    ) {
      status = candidate.blockers.length > 0 ? 'blocked' : 'partial'
    } else {
      status = candidate.status
    }
  }

  const report = {
    schema_version: WORKER_REPORT_SCHEMA_VERSION,
    task_id: taskId,
    run_id: runId,
    worker_id: workerId,
    report_id: deriveWorkerReportId(taskId, runId, workerId),
    model: getConfiguredSubagentModel(),
    effort_used: normalizeEffort(input.effortUsed),
    policy_epoch: policyIdentity.policyEpoch,
    policy_digest: policyIdentity.policyDigest,
    status,
    summary: candidate?.summary ?? invalidReportSummary(status),
    changed_files: changedFiles,
    evidence: candidateIsValid ? candidate.evidence : [],
    tokens_used: normalizeTokens(input.tokensUsed),
    validation: candidate?.validation ?? { verdict: 'fail' as const },
    blockers: candidate?.blockers ?? invalidReportBlockers(status),
  }

  return workerReportSchema.parse(report)
}

export function isWorkerReportCompletionEligible(
  report: WorkerReport,
  expected: WorkerPolicyIdentity,
): boolean {
  return isWorkerReportCompletionEligibleForPolicy(report, expected)
}

export function isWorkerReportCompletionEligibleForPolicy(
  report: WorkerReport,
  expected: WorkerPolicyIdentity,
): boolean {
  const parsed = workerReportSchema.safeParse(report)
  return (
    parsed.success &&
    parsed.data.policy_epoch === expected.policyEpoch &&
    parsed.data.policy_digest === expected.policyDigest &&
    parsed.data.status === 'completed' &&
    parsed.data.validation.verdict === 'pass' &&
    parsed.data.blockers.length === 0
  )
}

/**
 * Enforces the report/completion boundary. The validated result is persisted
 * first; only then may a caller transition its task lifecycle to completed.
 */
export function persistValidatedWorkerReport<
  T extends { workerReport: WorkerReport },
>(
  result: T,
  callbacks: {
    persist: (result: T) => void
    complete: (result: T) => void
    reject: (result: T) => void
  },
  expectedPolicy: WorkerPolicyIdentity,
): boolean {
  if (
    !isWorkerReportCompletionEligibleForPolicy(
      result.workerReport,
      expectedPolicy,
    )
  ) {
    callbacks.reject(result)
    return false
  }
  callbacks.persist(result)
  callbacks.complete(result)
  return true
}

export function parseWorkerReport(value: unknown): WorkerReport | null {
  const parsed = workerReportSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

export function serializeWorkerReport(report: WorkerReport): string {
  return JSON.stringify(workerReportSchema.parse(report))
}

export function appendWorkerReportEvidence(
  report: WorkerReport,
  evidence: WorkerEvidence | string,
): WorkerReport {
  const next =
    typeof evidence === 'string'
      ? runtimeEvidence(evidence.slice(0, MAX_SUMMARY_CHARS), report.evidence.length)
      : evidence
  const normalizedEvidence = normalizeEvidence([next])
  if (!normalizedEvidence || normalizedEvidence.length !== 1) {
    throw new Error('WorkerReport evidence must contain normalized workspace data')
  }
  const parsedEvidence = normalizedEvidence[0]
  if (!parsedEvidence) {
    throw new Error('WorkerReport evidence is empty')
  }
  const nextEvidence = [...report.evidence, parsedEvidence].filter(
    (item, index, items) =>
      items.findIndex(other => JSON.stringify(other) === JSON.stringify(item)) ===
      index,
  )
  return workerReportSchema.parse({
    ...report,
    evidence: nextEvidence.slice(0, MAX_EVIDENCE_ITEMS),
  })
}

export type WorkerReportInstructionContext = {
  runId?: string
  workerId?: string
  policyEpoch?: number
  policyDigest?: string
}

export function buildWorkerReportInstruction(
  taskId: string,
  effort: WorkerEffort,
  context: WorkerReportInstructionContext = {},
): string {
  const sample = {
    schema_version: WORKER_REPORT_SCHEMA_VERSION,
    task_id: taskId,
    run_id: context.runId ?? taskId,
    worker_id: context.workerId ?? taskId,
    report_id: '0'.repeat(WORKER_REPORT_ID_HEX_LENGTH),
    model: getConfiguredSubagentModel(),
    effort_used: effort,
    policy_epoch: context.policyEpoch ?? 0,
    policy_digest: context.policyDigest ?? '0'.repeat(64),
    status: 'completed',
    summary: 'concise bounded result',
    changed_files: [],
    evidence: [
      {
        id: 'check-1',
        type: 'test',
        command: 'bun test path/to/test',
        exit_code: 0,
      },
    ],
    tokens_used: 0,
    validation: { verdict: 'pass' },
    blockers: [],
  }
  return `<worker-report-contract>
Return exactly one JSON object as your final answer and no prose outside it:
${JSON.stringify(sample)}
Use exactly the top-level keys shown in the sample; put task-specific details only in summary and never add custom top-level fields. report_id, policy_epoch, and policy_digest are runtime-owned: include the keys if requested, but never calculate, replace, or rely on them. Use effort_used exactly as provided. List only workspace-relative files actually changed. Each evidence object may contain only id, type, path, command, exit_code, and digest; type must be file, diff, command, test, or artifact. Do not invent additional evidence keys; use an empty evidence array when none of those fields applies. Set validation.verdict to pass only after the declared checks pass. Use partial, blocked, or failed when completion is not justified. Never include prompts, tool calls, or the worker transcript.
</worker-report-contract>`
}

function resolveReportPolicyIdentity(
  input: BuildWorkerReportInput,
): WorkerPolicyIdentity {
  const { policyEpoch, policyDigest } = input
  if ((policyEpoch === undefined) !== (policyDigest === undefined)) {
    throw new Error(
      'Worker report policy identity requires policyEpoch with policyDigest',
    )
  }
  if (policyEpoch === undefined || policyDigest === undefined) {
    throw new Error(
      'Worker report policy epoch and source digest are required at the production boundary',
    )
  }
  if (
    !Number.isSafeInteger(policyEpoch) ||
    policyEpoch < 0 ||
    !/^[a-f0-9]{64}$/.test(policyDigest)
  ) {
    throw new Error('Worker report policy identity is malformed')
  }
  return Object.freeze({ policyEpoch, policyDigest })
}
