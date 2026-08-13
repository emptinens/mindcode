import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  RUN_WORKFLOW_ALIAS,
  WORKFLOW_RUN_ID_PREFIX,
  WORKFLOW_SCRIPT_MAX_BYTES,
  WORKFLOW_TOOL_NAME,
} from './constants.js'
import {
  areWorkflowsDisabledByManagedSettings,
  isWorkflowsEnabled,
} from './gate.js'
import { parseWorkflowScript, scriptIsNonDeterministic } from './meta.js'
import { WORKFLOW_TOOL_PROMPT } from './prompt.js'
import { listWorkflows, resolveWorkflowByName } from './registry.js'
import { runWorkflowSubagent } from './subagent.js'
import { runWorkflowScript, type WorkflowHooks } from './vm.js'
import {
  renderToolResultMessage,
  renderToolUseMessage,
  renderToolUseProgressMessage,
  type WorkflowAgentSnapshot,
} from './UI.js'
import {
  appendWorkflowLog,
  clearWorkflowAgentController,
  completeWorkflowTask,
  failWorkflowTask,
  registerWorkflowAgentController,
  registerWorkflowTask,
  upsertWorkflowAgent,
} from '../../tasks/LocalWorkflowTask/LocalWorkflowTask.js'

const inputSchema = lazySchema(() =>
  z
    .strictObject({
      script: z
        .string()
        .max(WORKFLOW_SCRIPT_MAX_BYTES)
        .optional()
        .describe(
          'Self-contained workflow script. Must begin with `export const meta = { name, description, phases }` (pure literal) followed by the body using agent()/parallel()/pipeline()/phase().',
        ),
      name: z
        .string()
        .optional()
        .describe(
          'Name of a predefined workflow (built-in or from .mindcode/workflows/).',
        ),
      description: z.string().optional().describe('Ignored — set in meta.'),
      title: z.string().optional().describe('Ignored — set in meta.'),
      args: z
        .unknown()
        .optional()
        .describe(
          'Optional input value exposed to the script as the global `args`, verbatim. Pass arrays/objects as actual JSON values, not a JSON-encoded string.',
        ),
      scriptPath: z
        .string()
        .optional()
        .describe('Path to a workflow script file on disk.'),
      resumeFromRunId: z
        .string()
        .regex(/^wf_[a-z0-9-]{6,}$/)
        .optional()
        .describe('Run ID of a prior Workflow invocation to resume from.'),
    })
    .refine(v => v.script || v.name || v.scriptPath, {
      message: 'Must provide script, name, or scriptPath',
    }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z.enum(['async_launched', 'completed', 'failed']),
    taskId: z.string(),
    taskType: z.string().optional(),
    workflowName: z.string().optional(),
    runId: z.string().optional(),
    summary: z.string().optional(),
    agentCount: z.number().optional(),
    totalTokens: z.number().optional(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

type ResolvedScript =
  | { script: string; workflowName?: string; source?: string }
  | { error: string }

async function resolveScript(input: z.infer<InputSchema>): Promise<ResolvedScript> {
  if (input.scriptPath) {
    try {
      const { readFileSync } = await import('fs')
      return { script: readFileSync(input.scriptPath, 'utf-8') }
    } catch (e) {
      return { error: `Could not read scriptPath: ${(e as Error).message}` }
    }
  }
  if (input.name) {
    const entry = resolveWorkflowByName(input.name)
    if (!entry) {
      const avail = listWorkflows()
        .map(w => w.name)
        .join(', ')
      return {
        error: `Workflow "${input.name}" not found. Available: ${avail || '(none)'}`,
      }
    }
    return { script: entry.script, workflowName: entry.name, source: entry.source }
  }
  if (input.script) return { script: input.script }
  return { error: 'Must provide script, name, or scriptPath' }
}

export const WorkflowTool = buildTool({
  name: WORKFLOW_TOOL_NAME,
  aliases: [RUN_WORKFLOW_ALIAS],
  searchHint: 'orchestrate subagents with a deterministic JavaScript workflow',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  userFacingName: () => 'Workflow',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return isWorkflowsEnabled()
  },
  isConcurrencySafe() {
    return false
  },
  toAutoClassifierInput(input) {
    return input.script ?? input.name ?? ''
  },
  getToolUseSummary(input) {
    if (input?.name) return `dynamic workflow: ${input.name}`
    if (!input?.script) return null
    const parsed = parseWorkflowScript(input.script)
    return 'error' in parsed
      ? 'dynamic workflow'
      : `dynamic workflow: ${parsed.meta.name}`
  },
  getActivityDescription(input) {
    if (input?.name) return `Running workflow ${input.name}`
    return 'Running dynamic workflow'
  },
  async validateInput(input) {
    if (areWorkflowsDisabledByManagedSettings()) {
      return {
        result: false,
        message:
          'Dynamic workflows are disabled by managed settings (`disableWorkflows`).',
        errorCode: 5,
      }
    }
    if (!isWorkflowsEnabled()) {
      return {
        result: false,
        message:
          'Dynamic workflows are not enabled for this session (org policy, launch gate, or the "Dynamic workflows" setting).',
        errorCode: 6,
      }
    }
    const resolved = await resolveScript(input)
    if ('error' in resolved) {
      return { result: false, message: resolved.error, errorCode: 1 }
    }
    const parsed = parseWorkflowScript(resolved.script)
    if ('error' in parsed) {
      return {
        result: false,
        message: `Invalid workflow script: ${parsed.error}`,
        errorCode: 2,
      }
    }
    // Determinism only enforced for inline scripts (named/file workflows are trusted).
    if (input.script && scriptIsNonDeterministic(parsed.scriptBody)) {
      return {
        result: false,
        message:
          'Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps via args.',
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async checkPermissions(input) {
    const name = input.scriptPath ? undefined : input.name
    return {
      behavior: 'ask',
      message: 'Review dynamic workflow before running',
      updatedInput: input,
      ...(name && {
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: WORKFLOW_TOOL_NAME, ruleContent: name }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      }),
    } as never
  },
  async description() {
    return WORKFLOW_TOOL_PROMPT
  },
  async prompt() {
    return WORKFLOW_TOOL_PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
      is_error: output.status === 'failed',
    }
  },
  renderToolUseMessage,
  renderToolUseProgressMessage,
  renderToolResultMessage,
  async call(input, context, canUseTool, parentMessage, onProgress) {
    const resolved = await resolveScript(input)
    if ('error' in resolved) {
      throw new Error(resolved.error)
    }
    const parsed = parseWorkflowScript(resolved.script)
    if ('error' in parsed) {
      throw new Error(`Invalid workflow script: ${parsed.error}`)
    }

    const rootSetAppState =
      context.setAppStateForTasks ?? context.setAppState
    const runId = `${WORKFLOW_RUN_ID_PREFIX}${randomUUID().slice(0, 12)}`
    const workflowName = resolved.workflowName ?? parsed.meta.name

    // Run synchronously within the tool call so subagents execute in a live,
    // valid context (reliable) and the synthesized result is returned to the
    // model — which relays it to the user. The controller is linked to the
    // turn so Esc cancels the whole workflow.
    const controller = new AbortController()
    const onTurnAbort = () => controller.abort()
    context.abortController.signal.addEventListener('abort', onTurnAbort, {
      once: true,
    })

    const taskId = registerWorkflowTask(rootSetAppState, {
      description: parsed.meta.description,
      toolUseId: context.toolUseId,
      summary: parsed.meta.description,
      workflowName,
      runId,
      phases: parsed.meta.phases,
      abortController: controller,
      isBackgrounded: false,
    })

    // Live snapshot emitted via onProgress so the spawned subagents render
    // inline in the transcript (the agent tree), like parallel subagents.
    const startTime = Date.now()
    const agentsSnap = new Map<string, WorkflowAgentSnapshot>()
    const logsSnap: string[] = []
    const emitProgress = () => {
      if (!onProgress) return
      onProgress({
        toolUseID: context.toolUseId ?? `workflow_${runId}`,
        data: {
          type: 'workflow_progress',
          workflowName,
          startTime,
          agents: [...agentsSnap.values()].sort((a, b) => a.index - b.index),
          logs: logsSnap.slice(-5),
        },
      } as never)
    }

    const hooks: WorkflowHooks = {
      abortSignal: controller.signal,
      budgetTotal: null,
      onLog: msg => {
        appendWorkflowLog(taskId, msg, rootSetAppState)
        logsSnap.push(msg)
        emitProgress()
      },
      onAgentUpdate: u => {
        upsertWorkflowAgent(
          taskId,
          {
            agentId: u.agentId,
            index: u.index,
            label: u.label,
            phaseIndex: u.phaseIndex,
            phaseTitle: u.phaseTitle,
            state: u.state,
            promptPreview: u.promptPreview,
            tokens: u.tokens,
            error: u.error,
          },
          rootSetAppState,
        )
        agentsSnap.set(u.agentId, {
          index: u.index,
          label: u.label,
          phaseTitle: u.phaseTitle,
          state: u.state,
          tokens: u.tokens,
        })
        emitProgress()
      },
      resolveWorkflowScript: name => resolveWorkflowByName(name)?.script,
      runAgentCall: async spec => {
        registerWorkflowAgentController(
          taskId,
          spec.agentId,
          spec.controller,
          rootSetAppState,
        )
        try {
          return await runWorkflowSubagent({
            prompt: spec.prompt,
            schema: spec.schema,
            agentType: spec.agentType,
            // Worker model is resolved by runWorkflowSubagent.
            effort: spec.effort,
            toolUseContext: context,
            canUseTool,
            parentMessage,
            abortController: spec.controller,
            transcriptSubdir: `workflows/${runId}`,
          })
        } finally {
          clearWorkflowAgentController(taskId, spec.agentId, rootSetAppState)
        }
      },
    }

    // Emit an initial snapshot so the agent panel appears immediately.
    emitProgress()

    try {
      const engine = await runWorkflowScript(
        parsed.scriptBody,
        input.args,
        hooks,
      )
      if (engine.error) {
        failWorkflowTask(taskId, engine.error, rootSetAppState)
        return {
          data: {
            status: 'failed' as const,
            taskId,
            taskType: 'local_workflow',
            workflowName,
            runId,
            error: engine.error,
            agentCount: engine.agentCount,
            totalTokens: engine.tokensSpent,
          },
        }
      }
      const summary =
        typeof engine.result === 'string'
          ? engine.result
          : jsonStringify(engine.result ?? null)
      completeWorkflowTask(
        taskId,
        {
          summary: summary.slice(0, 200),
          totalTokens: engine.tokensSpent,
          agentCount: engine.agentCount,
        },
        rootSetAppState,
      )
      return {
        data: {
          status: 'completed' as const,
          taskId,
          taskType: 'local_workflow',
          workflowName,
          runId,
          summary: summary.slice(0, 200),
          agentCount: engine.agentCount,
          totalTokens: engine.tokensSpent,
          // Full result returned to the model so it relays the answer to the user.
          result: engine.result,
        },
      }
    } finally {
      context.abortController.signal.removeEventListener('abort', onTurnAbort)
    }
  },
} satisfies ToolDef<InputSchema, Output>)
