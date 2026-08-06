import { promises as fsp } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  getSdkAgentProgressSummariesEnabled,
  getSessionId,
} from '../../bootstrap/state.js'
import {
  getSystemPrompt,
  getCompiledWorkerPolicySnapshot,
} from '../../constants/prompts.js'
import { isCoordinatorMode } from '../../coordinator/coordinatorMode.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  type WorkerTaskGraph,
  createWorkerTaskGraph,
} from '../../runtime/taskGraph/workerGraph.js'
import type { TaskRecord } from '../../tasks/graph/index.js'
import {
  parsePolicyEpochEnvironment,
  readCurrentPolicyEpochState,
} from '../../services/policy/index.js'
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
import { resolveWorkerRuntime } from '../../utils/swarm/backends/types.js'
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
  type WorkerCompletionEvidence,
} from './workerLifecycle.js'
import {
  type WorkerReport,
  buildWorkerReport,
  buildWorkerReportInstruction,
} from './workerReport.js'

const RUNTIME_TASK_PREFIX = 'mindcode-agent-runtime:'
const TARGET_SCOPE_PREFIX = '.mindcode-target-scope/'

function resolveWorkerPolicySnapshot() {
  const snapshot = getCompiledWorkerPolicySnapshot()
  const inherited = parsePolicyEpochEnvironment()
  if (
    inherited &&
    (inherited.epoch !== snapshot.policyEpoch ||
      inherited.digest !== snapshot.sourceDigest)
  ) {
    throw new Error('Inherited Worker policy epoch/digest mismatch')
  }
  const persisted = readCurrentPolicyEpochState()
  if (
    inherited &&
    persisted &&
    (persisted.epoch !== inherited.epoch ||
      persisted.digest !== inherited.digest)
  ) {
    throw new Error('Inherited Worker policy epoch is stale')
  }
  return snapshot
}

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

async function findPriorWorkerTask(
  agentId: string,
  runtimeScope: string,
  graph: WorkerTaskGraph,
  signal?: AbortSignal,
): Promise<TaskRecord | null> {
  const currentPrefix = runtimeTaskPrefix(runtimeScope)
  const matches = (await graph.list(signal))
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
  const workerPolicy = resolveWorkerPolicySnapshot()

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
      workerPolicy.prompt,
    ])
  }

  const workerRuntime = resolveWorkerRuntime(meta?.effort)
  const resolvedAgentModel = workerRuntime.model
  const effort = workerRuntime.effort

  const workerPermissionContext = {
    ...appState.toolPermissionContext,
    mode: selectedAgent.permissionMode ?? 'acceptEdits',
  }
  const workerTools = isResumedFork
    ? filterWorkerTools(toolUseContext.options.tools)
    : filterWorkerTools(
        assembleToolPool(workerPermissionContext, appState.mcp.tools),
      )

  const workerRunId = createAgentId('run')
  const workerPrompt = `${prompt}\n\n${buildWorkerReportInstruction(
    agentId,
    effort,
    {
      runId: workerRunId,
      workerId: agentId,
      policyEpoch: workerPolicy.policyEpoch,
    },
  )}`

  const runAgentParams: Parameters<typeof runAgent>[0] = {
    agentDefinition: selectedAgent,
    promptMessages: [
      ...resumedMessages,
      createUserMessage({ content: workerPrompt }),
    ],
    toolUseContext,
    canUseTool,
    isAsync: true,
    querySource: getQuerySourceForAgent(
      selectedAgent.agentType,
      isBuiltInAgent(selectedAgent),
    ),
    model: workerRuntime.model,
    effort,
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

  const runtimeScope = getWorkerRuntimeScope(getSessionId(), getCwd())
  const targetScope = resumedWorktreePath ?? getCwd()
  const workerGraph = createWorkerTaskGraph()
  let priorTask: TaskRecord | null
  let workerExecution: Awaited<ReturnType<typeof acquireWorkerExecution>>
  try {
    priorTask = await findPriorWorkerTask(
      agentId,
      runtimeScope,
      workerGraph,
      toolUseContext.abortController.signal,
    )
    const executionTaskId = resumeWorkerTaskId(
      agentId,
      workerRunId,
      priorTask,
      runtimeScope,
    )

    // Resume must acquire a fresh scheduler and task-graph lifecycle before
    // the replacement LocalAgentTask is registered. The same adapter instance
    // is used for prior-task lookup and acquisition, so a lifecycle can never
    // switch from daemon authority to local authority halfway through.
    workerExecution = await acquireWorkerExecution(
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
        policyEpoch: workerPolicy.policyEpoch,
        policyDigest: workerPolicy.sourceDigest,
        signal: toolUseContext.abortController.signal,
      },
      {
        graph: workerGraph,
        closeGraph: true,
        resolveExternalDependency: async dependencyId => {
          const dependency = await getTask(getTaskListId(), dependencyId)
          if (!dependency) return 'missing'
          if (dependency.status === 'completed') return 'completed'
          if (dependency.status === 'failed') return 'failed'
          return 'incomplete'
        },
      },
    )
  } catch (error) {
    await workerGraph.close().catch(() => undefined)
    throw error
  }

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
    policyEpoch: workerPolicy.policyEpoch,
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

  const settleWorkerExecution = async (
    action: 'complete' | 'fail' | 'release',
    report?: WorkerReport,
  ) => {
    try {
      const evidence: WorkerCompletionEvidence | undefined = report
        ? {
            reportId: report.report_id,
            policyEpoch: report.policy_epoch,
            policyDigest: workerPolicy.sourceDigest,
          }
        : undefined
      await workerExecution[action](evidence)
    } catch (error) {
      logForDebugging(
        `Failed to ${action} resumed task graph lifecycle for ${agentId}: ${String(error)}`,
        { level: 'error' },
      )
    }
  }

  const buildLifecycleFailureReport = (reason: string): WorkerReport =>
    buildWorkerReport({
      taskId: agentId,
      runId: workerRunId,
      workerId: agentId,
      policyEpoch: workerPolicy.policyEpoch,
      status: 'failed',
      finalText: reason,
      tokensUsed: 0,
      effortUsed: effort,
    })

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
    const workerAbortController = agentBackgroundTask.abortController
    if (!workerAbortController) {
      throw new Error('Resumed worker did not provide an abort controller')
    }

    const asyncLifecycle = runWithAgentContext(asyncAgentContext, () =>
      wrapWithCwd(() =>
        runAsyncAgentLifecycle({
          taskId: agentBackgroundTask.agentId,
          abortController: workerAbortController,
          makeStream: onCacheSafeParams =>
            runAgent({
              ...runAgentParams,
              override: {
                ...runAgentParams.override,
                agentId: asAgentId(agentBackgroundTask.agentId),
                abortController: workerAbortController,
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
          onExecutionCompleted: result =>
            void settleWorkerExecution('complete', result.workerReport),
          onExecutionFailed: error => {
            void settleWorkerExecution(
              'fail',
              buildLifecycleFailureReport(
                error instanceof Error ? error.message : String(error),
              ),
            )
          },
          onExecutionReleased: () => void settleWorkerExecution('release'),
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
      void settleWorkerExecution('release')
    }
    throw error
  }

  return {
    agentId,
    description: uiDescription,
    outputFile: getTaskOutputPath(agentId),
  }
}
