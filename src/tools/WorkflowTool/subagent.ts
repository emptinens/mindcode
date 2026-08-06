// Bridge between the workflow DSL `agent()` hook and the real subagent runtime.
// Builds a workflow-subagent AgentDefinition and runs it to completion via
// runAgent(), returning the final text (or a validated object for schema mode).

import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import { createAgentId } from '../../utils/uuid.js'
import { createUserMessage, extractTextContent } from '../../utils/messages.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import { getWorkerPolicyIdentity } from '../../services/policy/index.js'
import type {
  AgentDefinition,
  BuiltInAgentDefinition,
} from '../AgentTool/loadAgentsDir.js'
import { finalizeAgentTool } from '../AgentTool/agentToolUtils.js'
import { runAgent } from '../AgentTool/runAgent.js'
import { WORKFLOW_SUBAGENT_TYPE } from './constants.js'
import { resolveWorkerRuntime } from '../../utils/swarm/backends/types.js'
const SUBAGENT_PREAMBLE =
  'You are a subagent spawned by a workflow orchestration script. Use the tools available to complete the task.'

const VERBATIM_RETURN_PROMPT = `${SUBAGENT_PREAMBLE}

CRITICAL: Your final text response is returned **verbatim** as a string to the calling script — it is your return value, not a human-facing message. Return raw data/results, not prose or acknowledgments.`

function structuredPrompt(schema: unknown): string {
  return `${SUBAGENT_PREAMBLE}

CRITICAL: The calling script expects a single JSON value matching this JSON Schema:
${JSON.stringify(schema, null, 2)}

- Do your work (read files, run commands, search), then return your answer.
- Your FINAL message must be ONLY the JSON value — no prose, no markdown fences, no commentary. The script parses your final message as JSON.
- If you cannot satisfy the schema, return a JSON object with an "error" string field.`
}

/** The default built-in subagent used by agent() when no agentType is given. */
export const WORKFLOW_SUBAGENT: BuiltInAgentDefinition = {
  agentType: WORKFLOW_SUBAGENT_TYPE,
  whenToUse: 'Internal subagent for workflow script orchestration.',
  tools: ['*'],
  source: 'built-in',
  baseDir: 'built-in',
  permissionMode: 'acceptEdits',
  getSystemPrompt: () => VERBATIM_RETURN_PROMPT,
}

export function getWorkflowSubagents(): AgentDefinition[] {
  return [WORKFLOW_SUBAGENT]
}

export type SubagentRunOptions = {
  prompt: string
  schema?: unknown
  agentType?: string
  // Worker model is fixed by resolveWorkerRuntime at admission.
  effort?: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  parentMessage: AssistantMessage
  abortController: AbortController
  transcriptSubdir?: string
}

export type SubagentRunResult = {
  text: string
  structured?: unknown
  tokens: number
  skipped: boolean
  error?: string
}
function parseStructured(text: string): unknown {
  let t = text.trim()
  // strip ```json ... ``` fences
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)
  if (fence) t = fence[1]!.trim()
  try {
    return JSON.parse(t)
  } catch {
    // fall back to first balanced {...} or [...] in the text
    const start = t.search(/[[{]/)
    if (start >= 0) {
      const open = t[start]!
      const close = open === '{' ? '}' : ']'
      let depth = 0
      for (let i = start; i < t.length; i++) {
        if (t[i] === open) depth++
        else if (t[i] === close && --depth === 0) {
          try {
            return JSON.parse(t.slice(start, i + 1))
          } catch {
            return undefined
          }
        }
      }
    }
    return undefined
  }
}

/**
 * Resolve the AgentDefinition for an agent() call. A custom agentType is looked
 * up from the parent's agent registry; otherwise the workflow-subagent is used.
 * Schema mode swaps in the structured-output system prompt.
 */
function resolveAgentDefinition(
  opts: SubagentRunOptions,
): AgentDefinition {
  const base: AgentDefinition = WORKFLOW_SUBAGENT
  let def = base
  if (opts.agentType) {
    const custom = opts.toolUseContext.options.agentDefinitions?.agents?.find(
      a => a.agentType === opts.agentType,
    )
    if (custom) def = custom
  }
  if (opts.schema !== undefined) {
    const schemaPrompt = structuredPrompt(opts.schema)
    return {
      ...def,
      // override prompt to force JSON output for schema mode
      getSystemPrompt: () => schemaPrompt,
    } as AgentDefinition
  }
  return def
}
export async function runWorkflowSubagent(
  opts: SubagentRunOptions,
): Promise<SubagentRunResult> {
  const workerRuntime = resolveWorkerRuntime(opts.effort)
  const agentDefinition = resolveAgentDefinition(opts)
  const agentId = createAgentId()

  // Build the worker's tool pool independently (acceptEdits), lazy-required to
  // avoid the tools.ts <-> WorkflowTool circular import at module-eval time.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { assembleToolPool } =
    require('../../tools.js') as typeof import('../../tools.js')
  const appState = opts.toolUseContext.getAppState()
  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: 'acceptEdits' as const,
  }
  const availableTools = assembleToolPool(
    workerPermissionContext,
    appState.mcp.tools,
  )
  const promptMessages: Message[] = [createUserMessage({ content: opts.prompt })]
  const startTime = Date.now()
  const messages: Message[] = []
  const workerPolicy = getWorkerPolicyIdentity()
  try {
    for await (const msg of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: opts.toolUseContext,
      canUseTool: opts.canUseTool,
      isAsync: true,
      canShowPermissionPrompts: false,
      querySource: getQuerySourceForAgent(agentDefinition.agentType, true),
      effort: workerRuntime.effort,
      policyEpoch: workerPolicy.policyEpoch,
      policyDigest: workerPolicy.policyDigest,
      availableTools,
      override: { agentId, abortController: opts.abortController },
      transcriptSubdir: opts.transcriptSubdir,
    })) {
      messages.push(msg)
    }
  } catch (e) {
    if (opts.abortController.signal.aborted) {
      return { text: '', tokens: 0, skipped: true }
    }
    return { text: '', tokens: 0, skipped: false, error: (e as Error).message }
  }
  if (opts.abortController.signal.aborted) {
    return { text: '', tokens: 0, skipped: true }
  }
  let result
  try {
    result = finalizeAgentTool(messages, agentId, {
      prompt: opts.prompt,
      resolvedAgentModel: workerRuntime.model,
      isBuiltInAgent: true,
      startTime,
      agentType: agentDefinition.agentType,
      isAsync: true,
      policyEpoch: workerPolicy.policyEpoch,
      policyDigest: workerPolicy.policyDigest,
    })
  } catch (e) {
    return { text: '', tokens: 0, skipped: false, error: (e as Error).message }
  }

  const text = extractTextContent(result.content, '\n')
  const tokens = result.totalTokens ?? 0
  if (opts.schema !== undefined) {
    const structured = parseStructured(text)
    if (structured === undefined) {
      return {
        text,
        tokens,
        skipped: false,
        error: 'subagent did not return valid JSON for the requested schema',
      }
    }
    return { text, structured, tokens, skipped: false }
  }
  return { text, tokens, skipped: false }
}
