import { z } from 'zod/v4'
import {
  type WorkerReport,
  appendWorkerReportEvidence,
  buildWorkerReport,
  deriveWorkerReportId,
  isWorkerReportCompletionEligible,
  serializeWorkerReport,
  workerReportSchema,
} from '../../tools/AgentTool/workerReport.js'
import type { WorkerEffort } from './backends/types.js'

export { deriveWorkerReportId, isWorkerReportCompletionEligible }

const WORKER_TEAM_REPORT_IDLE_REASONS = [
  'available',
  'interrupted',
  'failed',
] as const

export const workerTeamReportMessageSchema = z.object({
  type: z.literal('idle_notification'),
  from: z.string().min(1),
  timestamp: z.string().min(1),
  idleReason: z.enum(WORKER_TEAM_REPORT_IDLE_REASONS),
  report: workerReportSchema,
})

export type WorkerTeamReportMessage = z.infer<
  typeof workerTeamReportMessageSchema
>

export type BuildWorkerTeamReportInput = {
  taskId: string
  runId?: string
  workerId?: string
  policyEpoch?: number
  status: WorkerReport['status']
  effortUsed?: WorkerEffort
  tokensUsed: number
  changedFiles?: readonly string[]
  evidence?: readonly string[]
  finalText?: string
}

/**
 * Creates the canonical report used by both AgentTool workers and persistent
 * team teammates. Only the explicitly supplied final assistant text is
 * normalized; callers must never pass a transcript.
 */
export function buildWorkerTeamReport(
  input: BuildWorkerTeamReportInput,
): WorkerReport {
  let report = buildWorkerReport({
    taskId: input.taskId,
    runId: input.runId,
    workerId: input.workerId,
    policyEpoch: input.policyEpoch,
    status: input.status,
    declaredChangedFiles: input.changedFiles,
    finalText: input.finalText,
    tokensUsed: input.tokensUsed,
    effortUsed: input.effortUsed ?? 'medium',
  })
  for (const evidence of input.evidence ?? []) {
    report = appendWorkerReportEvidence(report, evidence)
  }
  return report
}

type WorkerMessage = {
  type: string
  uuid?: string
  requestId?: string
  isApiErrorMessage?: boolean
  error?: unknown
  errorDetails?: unknown
  message?: {
    id?: string
    model?: string
    content?: readonly { type: string; text?: string }[]
    usage?: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

type AssistantWorkerMessage = Omit<WorkerMessage, 'type' | 'message'> & {
  type: 'assistant'
  message: {
    id?: string
    model: string
    content: readonly { type: string; text?: string }[]
    usage: {
      input_tokens: number
      output_tokens: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

function isAssistantMessage(
  message: WorkerMessage,
): message is AssistantWorkerMessage {
  return message.type === 'assistant'
}

function getFinalAssistantMessage(
  messages: readonly WorkerMessage[],
): AssistantWorkerMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message && isAssistantMessage(message)) return message
  }
  return undefined
}

function getFinalAssistantText(
  message: AssistantWorkerMessage | undefined,
): string | undefined {
  if (!message) return undefined
  const text = message.message.content
    .flatMap(block => (block.type === 'text' ? [block.text] : []))
    .join('\n')
    .trim()
  return text || undefined
}

function getApiErrorEvidence(
  message: AssistantWorkerMessage,
  finalText: string | undefined,
): string {
  if (typeof message.error === 'string' && message.error.trim()) {
    return message.error.trim()
  }
  if (typeof message.errorDetails === 'string' && message.errorDetails.trim()) {
    return message.errorDetails.trim()
  }
  return finalText ?? 'API request failed'
}

/**
 * Returns incremental usage while mutating countedUsageIds. Split assistant
 * records from one API response share an id and are counted exactly once.
 */
export function accumulateWorkerTokenUsage(
  messages: readonly WorkerMessage[],
  countedUsageIds: Set<string> = new Set<string>(),
): number {
  let tokensUsed = 0
  for (const message of messages) {
    if (!isAssistantMessage(message)) continue
    if (message.message.model === '<synthetic>') continue
    const usage = message.message.usage
    const usageId =
      message.message.id || message.requestId || message.uuid || undefined
    if (usageId && countedUsageIds.has(usageId)) continue
    if (usageId) countedUsageIds.add(usageId)
    tokensUsed +=
      usage.input_tokens +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      usage.output_tokens
  }
  return tokensUsed
}

export type BuildWorkerTeamReportFromMessagesInput = Omit<
  BuildWorkerTeamReportInput,
  'finalText' | 'status' | 'tokensUsed'
> & {
  messages: readonly WorkerMessage[]
  status?: WorkerReport['status']
  tokensUsed?: number
}

/**
 * Builds a report from only the final assistant message. Earlier prompts,
 * tool calls, and assistant turns are inspected only for deduplicated usage
 * and can never become report evidence.
 */
export function buildWorkerTeamReportFromMessages(
  input: BuildWorkerTeamReportFromMessagesInput,
): WorkerReport {
  const finalAssistant = getFinalAssistantMessage(input.messages)
  const finalText = getFinalAssistantText(finalAssistant)
  const isApiError = finalAssistant?.isApiErrorMessage === true
  const apiErrorEvidence =
    isApiError && finalAssistant
      ? getApiErrorEvidence(finalAssistant, finalText)
      : undefined

  return buildWorkerTeamReport({
    taskId: input.taskId,
    runId: input.runId,
    workerId: input.workerId,
    policyEpoch: input.policyEpoch,
    status: isApiError ? 'failed' : (input.status ?? 'completed'),
    effortUsed: input.effortUsed,
    tokensUsed:
      input.tokensUsed ?? accumulateWorkerTokenUsage(input.messages),
    changedFiles: input.changedFiles,
    evidence: apiErrorEvidence
      ? [apiErrorEvidence, ...(input.evidence ?? [])]
      : input.evidence,
    finalText: isApiError ? undefined : finalText,
  })
}

export function createWorkerTeamReportMessage(params: {
  from: string
  report: WorkerReport
  idleReason: WorkerTeamReportMessage['idleReason']
}): WorkerTeamReportMessage {
  return workerTeamReportMessageSchema.parse({
    type: 'idle_notification',
    from: params.from,
    timestamp: new Date().toISOString(),
    idleReason: params.idleReason,
    report: workerReportSchema.parse(params.report),
  })
}

export function serializeWorkerTeamReportMessage(
  message: WorkerTeamReportMessage,
): string {
  return JSON.stringify(workerTeamReportMessageSchema.parse(message))
}

export function parseWorkerTeamReportMessage(
  value: string,
): WorkerTeamReportMessage | null {
  try {
    const parsed: unknown = JSON.parse(value)
    const result = workerTeamReportMessageSchema.safeParse(parsed)
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/**
 * Keep the transport envelope separate from the result payload. This helper
 * is intentionally the only serializer used for completion/error/idle
 * notifications sent to a Leader mailbox.
 */
export function serializeWorkerTeamReport(
  report: WorkerReport,
): string {
  return serializeWorkerReport(workerReportSchema.parse(report))
}
