import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  getSdkAgentProgressSummariesEnabled,
  getSessionId,
} from '../../bootstrap/state.js'
import {
  getSystemPrompt,
  getWorkerPolicySnapshot,
} from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import type { TaskRecord } from '../../tasks/graph/index.js'
import { openTaskGraph } from '../../tasks/graph/taskGraph.js'
import {
  killAsyncAgent,
  registerAsyncAgent,
} from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { assembleToolPool } from '../../tools.js'
import { asAgentId } from '../../types/ids.js'
import { runWithAgentContext } from '../../utils/agentContext.js'
import { getCwd, runWithCwdOverride } from '../../utils/cwd.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
} from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { resolveWorkerEffort } from '../../utils/swarm/backends/types.js'
import { getQuerySourceForAgent } from '../../utils/promptCategory.js'
import {
  getAgentTranscript,
  readAgentMetadata,
} from '../../utils/sessionStorage.js'
import { buildEffectiveSystemPrompt } from '../../utils/systemPrompt.js'
import {
  type SystemPrompt,
  asSystemPrompt,
} from '../../utils/systemPromptType.js'
import { getTaskOutputPath } from '../../utils/task/diskOutput.js'
import { getTask, getTaskListId } from '../../utils/tasks.js'
import { getParentSessionId } from '../../utils/teammate.js'
import { reconstructForSubagentResume } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { runAsyncAgentLifecycle } from './agentToolUtils.js'
import { GENERAL_PURPOSE_AGENT } from './built-in/generalPurposeAgent.js'
import { FORK_AGENT, isForkSubagentEnabled } from './forkSubagent.js'
import type { AgentDefinition } from './loadAgentsDir.js'
import { isBuiltInAgent } from './loadAgentsDir.js'
import { runAgent } from './runAgent.js'
import { filterWorkerTools } from './workerTools.js'
import {
  acquireWorkerExecution,
  getWorkerRuntimeScope,
} from './workerLifecycle.js'

const RUNTIME_TASK_PREFIX = 'mindcode-agent-runtime:'
const TARGET_SCOPE_PREFIX = '.mindcode-target-scope/'

function runtimeTaskPrefix(runtimeScope: string): string {
  return `${RUNTIME_TASK_PREFIX}${createHash('sha256')
    .update(runtimeScope)
    .digest('hex')
    .slice(0, 24)}:`
}

function publicTaskId(taskId: string): string {
  if (!taskId.startsWith(RUNTIME_TASK_PREFIX)) return taskId
  const encoded = taskId.slice(taskId.lastIndexOf(':') + 1)
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return taskId
  }
}

function publicTarget(target: string): string {
  if (!target.startsWith(TARGET_SCOPE_PREFIX)) return target
  const separator = target.indexOf('/', TARGET_SCOPE_PREFIX.length)
  return separator === -1 ? target : target.slice(separator + 1)
}

function findPriorWorkerTask(agentId: string, runtimeScope: string): TaskRecord | null {
  const graph = openTaskGraph()
  try {
    const currentPrefix = runtimeTaskPrefix(runtimeScope)
    const matches = graph
      .list()
      .filter(task => publicTaskId(task.id) === agentId)
      .sort((left, right) => {
        const leftTime = Date.parse(left.started_at ?? left.finished_at ?? '')
        const rightTime = Date.parse(right.started_at ?? right.finished_at ?? '')
        return rightTime - leftTime
      })
    // A pending task from this runtime is the released execution being
    // resumed. Reusing its public ID preserves the graph's idempotency entry;
    // terminal or stale-runtime rows need a fresh graph task for this run.
    return (
      matches.find(
        task => task.status === 'pending' && task.id.startsWith(currentPrefix),
      ) ?? matches[0] ?? null
    )
  } finally {
    graph.close()
  }
}

function resumeWorkerTaskId(
  agentId: string,
  runId: string,
  priorTask: TaskRecord | null,
  runtimeScope: string,
): string {
  if (
    priorTask?.status === 'pending' &&
    priorTask.id.startsWith(runtimeTaskPrefix(runtimeScope))
  ) {
    return agentId
  }
  return runId
}

export type ResumeAgentResult = {
  agentId: string
  description: string
  outputFile: string
}
export async function resumeAgentBackground({
  agentId,
  prompt,
  toolUseContext,
  canUseTool,
  invokingRequestId,
}: {
  agentId: string
  prompt: string
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  invokingRequestId?: string
}): Promise<ResumeAgentResult> {
  const startTime = Date.now()
  const appState = toolUseContext.getAppState()
  // In-process teammates get a no-op setAppState; setAppStateForTasks
  // reaches the root store so task registration/progress/kill stay visible.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState
  const permissionMode = appState.toolPermissionContext.mode

  const [transcript, meta] = await Promise.all([
    getAgentTranscript(asAgentId(agentId)),
    readAgentMetadata(asAgentId(agentId)),
  ])
  if (!transcript) {
    throw new Error(`No transcript found for agent ID: ${agentId}`)
  }
  const resumedMessages = filterWhitespaceOnlyAssistantMessages(
    filterOrphanedThinkingOnlyMessages(
      filterUnresolvedToolUses(transcript.messages),
    ),
  )
  const resumedReplacementState = reconstructForSubagentResume(
    toolUseContext.contentReplacementState,
    resumedMessages,
    transcript.contentReplacements,
  )
  // Best-effort: if the original worktree was removed externally, fall back
  // to parent cwd rather than crashing on chdir later.
  const resumedWorktreePath = meta?.worktreePath
    ? await fsp.stat(meta.worktreePath).then(
        s => (s.isDirectory() ? meta.worktreePath : undefined),
        () => {
          logForDebugging(
            `Resumed worktree ${meta.worktreePath} no longer exists; falling back to parent cwd`,
          )
          return undefined
        },
      )
    : undefined
  if (resumedWorktreePath) {
    // Bump mtime so stale-worktree cleanup doesn't delete a just-resumed worktree (#22355)
    const now = new Date()
    await fsp.utimes(resumedWorktreePath, now, now)
  }

  // Skip filterDeniedAgents re-gating — original spawn already passed permission checks
  let selectedAgent: AgentDefinition
  let isResumedFork = false
  if (meta?.agentType === FORK_AGENT.agentType) {
    selectedAgent = FORK_AGENT
    isResumedFork = true
  } else if (meta?.agentType) {
    const found = toolUseContext.options.agentDefinitions.activeAgents.find(
      a => a.agentType === meta.agentType,
    )
    selectedAgent = found ?? GENERAL_PURPOSE_AGENT
  } else {
    selectedAgent = GENERAL_PURPOSE_AGENT
  }

  const uiDescription = meta?.description ?? '(resumed)'

  let forkParentSystemPrompt: SystemPrompt | undefined
  if (isResumedFork) {
    if (toolUseContext.renderedSystemPrompt) {
      forkParentSystemPrompt = toolUseContext.renderedSystemPrompt
    } else {
      const mainThreadAgentDefinition = appState.agent
        ? appState.agentDefinitions.activeAgents.find(
            a => a.agentType === appState.agent,
          )
        : undefined
      const additionalWorkingDirectories = Array.from(
        appState.toolPermissionContext.additionalWorkingDirectories.keys(),
      )
      const defaultSystemPrompt = await getSystemPrompt(
        toolUseContext.options.tools,
        toolUseContext.options.mainLoopModel,
        additionalWorkingDirectories,
        toolUseContext.options.mcpClients,
      )
      forkParentSystemPrompt = buildEffectiveSystemPrompt({
        mainThreadAgentDefinition,
        toolUseContext,
        customSystemPrompt: toolUseContext.options.customSystemPrompt,
        defaultSystemPrompt,
        appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
      })
    }
    if (!forkParentSystemPrompt) {
      throw new Error(
        'Cannot resume fork agent: unable to reconstruct parent system prompt',
      )
    }
    // Fork resumes inherit the parent prompt for cache continuity, then receive
    // the current canonical worker policy snapshot at the worker boundary.
    forkParentSystemPrompt = asSystemPrompt([
      ...forkParentSystemPrompt,
      getWorkerPolicySnapshot(),
    ])
  }

  // Resolve model for analytics metadata (runAgent resolves its own internally)
  const resolvedAgentModel = getAgentModel(
    selectedAgent.model,
    toolUseContext.options.mainLoopModel,
    undefined,
    permissionMode,
  )

  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = isResumedFork
    ? filterWorkerTools(toolUseContext.options.tools)
    : filterWorkerTools(
        assembleToolPool(workerPermissionContext, appState.mcp.tools),
      )

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: prompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: undefined,
    // Preserve resolved worker effort; legacy metadata defaults to medium.
    effort: resolveWorkerEffort(meta?.effort),
    // Fork resume: pass parent's system prompt (cache-identical prefix).
    // Non-fork: undefined → runAgent recomputes under wrapWithCwd so
    // getCwd() sees resumedWorktreePath.
    override: isResumedFork
      ? { systemPrompt: forkParentSystemPrompt }
      : undefined,
    availableTools: workerTools,
    // Transcript already contains the parent context slice from the
    // original fork. Re-supplying it would cause duplicate tool_use IDs.
    forkContextMessages: undefined,
    ...(isResumedFork && { useExactTools: true }),
    // Re-persist so metadata survives runAgent's writeAgentMetadata overwrite
    worktreePath: resumedWorktreePath,
    description: meta?.description,
    contentReplacementState: resumedReplacementState,
  }

  const workerRunId = createAgentId('run')
  const runtimeScope = getWorkerRuntimeScope(getSessionId(), getCwd())
  const targetScope = resumedWorktreePath ?? getCwd()
  const priorTask = findPriorWorkerTask(agentId, runtimeScope)
  const executionTaskId = resumeWorkerTaskId(
    agentId,
    workerRunId,
    priorTask,
    runtimeScope,
  )
  const effort = resolveWorkerEffort(meta?.effort)

  // Resume must acquire a fresh scheduler and task-graph lifecycle before the
  // replacement LocalAgentTask is registered. Reusing a pending row is safe;
  // terminal rows receive a new run ID while retaining their target sets so
  // overlap validation still gates the resumed work.
  const workerExecution = await acquireWorkerExecution(
    {
      taskId: executionTaskId,
      owner: workerRunId,
      schedulerScope: `${getParentSessionId() ?? 'leader'}:${getCwd()}`,
      effort,
      filesTouched: priorTask?.files_touched.map(publicTarget),
      readSet: priorTask?.read_set.map(publicTarget),
      writeSet: priorTask?.write_set.map(publicTarget),
      // A reused pending row keeps its existing dependencies atomically.
      // A fresh resume run must not inherit already-satisfied or stale IDs
      // from a terminal execution in another runtime namespace.
      isolation: resumedWorktreePath ? 'worktree' : 'shared',
      runtimeScope,
      targetScope,
      signal: toolUseContext.abortController.signal,
    },
    {
      resolveExternalDependency: async dependencyId => {
        const dependency = await getTask(getTaskListId(), dependencyId)
        if (!dependency) return 'missing'
        if (dependency.status === 'completed') return 'completed'
        if (dependency.status === 'failed') return 'failed'
        return 'incomplete'
      },
    },
  )

  const metadata = {
    prompt,
    resolvedAgentModel,
    isBuiltInAgent: isBuiltInAgent(selectedAgent),
    startTime,
    agentType: selectedAgent.agentType,
    isAsync: true,
    taskId: agentId,
    runId: workerRunId,
    workerId: agentId,
    policyEpoch: 0,
    effort,
  }

  const asyncAgentContext = {
    agentId,
    parentSessionId: getParentSessionId(),
    agentType: 'subagent' as const,
    subagentName: selectedAgent.agentType,
    isBuiltIn: isBuiltInAgent(selectedAgent),
    invokingRequestId,
    invocationKind: 'resume' as const,
    invocationEmitted: false,
  }

  const wrapWithCwd = <T>(fn: () => T): T =>
    resumedWorktreePath ? runWithCwdOverride(resumedWorktreePath, fn) : fn()

  const settleWorkerExecution = (action: 'complete' | 'fail' | 'release') => {
    try {
      workerExecution[action]()
    } catch (error) {
      logForDebugging(
        `Failed to ${action} resumed task graph lifecycle for ${agentId}: ${String(error)}`,
        { level: 'error' },
      )
    }
  }

  let executionHandedOff = false
  let registeredAsyncAgent = false
  try {
    // Skip name-registry write — original entry persists from the initial spawn
    const agentBackgroundTask = registerAsyncAgent({
      agentId,
      description: uiDescription,
      prompt,
      selectedAgent,
      setAppState: rootSetAppState,
      toolUseId: toolUseContext.toolUseId,
    })
    registeredAsyncAgent = true

    const asyncLifecycle = runWithAgentContext(asyncAgentContext, () =>
      wrapWithCwd(() =>
        runAsyncAgentLifecycle({
          taskId: agentBackgroundTask.agentId,
          abortController: agentBackgroundTask.abortController!,
          makeStream: onCacheSafeParams =>
            runAgent({
              ...runAgentParams,
              override: {
                ...runAgentParams.override,
                agentId: asAgentId(agentBackgroundTask.agentId),
                abortController: agentBackgroundTask.abortController!,
              },
              onCacheSafeParams,
            }),
          metadata,
          description: uiDescription,
          toolUseContext,
          rootSetAppState,
          agentIdForCleanup: agentId,
          enableSummarization:
            isCoordinatorMode() ||
            isForkSubagentEnabled() ||
            getSdkAgentProgressSummariesEnabled(),
          getWorktreeResult: async () =>
            resumedWorktreePath ? { worktreePath: resumedWorktreePath } : {},
          onExecutionCompleted: () => settleWorkerExecution('complete'),
          onExecutionFailed: () => settleWorkerExecution('fail'),
          onExecutionReleased: () => settleWorkerExecution('release'),
        }),
      ),
    )
    executionHandedOff = true
    void asyncLifecycle
  } catch (error) {
    if (!executionHandedOff) {
      if (registeredAsyncAgent) {
        killAsyncAgent(agentId, rootSetAppState)
      }
      settleWorkerExecution('release')
    }
    throw error
  }

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
