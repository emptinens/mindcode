// Background task entry for a running dynamic workflow. Surfaces the workflow
// (and its per-agent fan-out) in the footer pill, Shift+Down dialog, and the
// /workflows view. Mirrors the other tasks/* modules.

import type { SetAppState, Task, TaskStateBase } from '../../Task.js'
import { createTaskStateBase, generateTaskId } from '../../Task.js'
import { registerTask, updateTaskState } from '../../utils/task/framework.js'

export type WorkflowAgentState = {
  agentId: string
  index: number
  label: string
  phaseIndex?: number
  phaseTitle?: string
  state: 'queued' | 'running' | 'done' | 'error' | 'skipped'
  promptPreview?: string
  startedAt?: number
  endedAt?: number
  tokens?: number
  error?: string
}

export type LocalWorkflowTaskState = TaskStateBase & {
  type: 'local_workflow'
  isBackgrounded?: boolean
  summary?: string
  workflowName?: string
  runId?: string
  agentCount: number
  totalTokens?: number
  agents: WorkflowAgentState[]
  logs: string[]
  phases?: { title: string; detail?: string }[]
  /** Main run controller; aborting it stops the whole workflow. */
  abortController?: AbortController
  /**
   * Per-agent abort controllers. Map (not Record) so .set/.delete don't change
   * the container identity (see sessionHooks.ts comment). Mutated in place.
   */
  agentControllers: Map<string, AbortController>
}

export function isLocalWorkflowTask(
  task: unknown,
): task is LocalWorkflowTaskState {
  return (
    typeof task === 'object' &&
    task !== null &&
    'type' in task &&
    (task as { type?: unknown }).type === 'local_workflow'
  )
}

export function registerWorkflowTask(
  setAppState: SetAppState,
  opts: {
    description: string
    toolUseId?: string
    summary?: string
    workflowName?: string
    runId?: string
    phases?: { title: string; detail?: string }[]
    abortController: AbortController
    isBackgrounded?: boolean
  },
): string {
  const id = generateTaskId('local_workflow')
  const task: LocalWorkflowTaskState = {
    ...createTaskStateBase(id, 'local_workflow', opts.description, opts.toolUseId),
    type: 'local_workflow',
    status: 'running',
    isBackgrounded: opts.isBackgrounded ?? false,
    summary: opts.summary,
    workflowName: opts.workflowName,
    runId: opts.runId,
    agentCount: 0,
    totalTokens: 0,
    agents: [],
    logs: [],
    phases: opts.phases,
    abortController: opts.abortController,
    agentControllers: new Map(),
  }
  registerTask(task, setAppState)
  return id
}

const MAX_LOGS = 1000

export function appendWorkflowLog(
  taskId: string,
  message: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    logs: task.logs.slice(-(MAX_LOGS - 1)).concat(message),
  }))
}

export function upsertWorkflowAgent(
  taskId: string,
  agent: WorkflowAgentState,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    const i = task.agents.findIndex(a => a.agentId === agent.agentId)
    const agents =
      i === -1
        ? [...task.agents, agent]
        : task.agents.map((a, j) => (j === i ? { ...a, ...agent } : a))
    const agentCount = agents.length
    const totalTokens = agents.reduce((sum, a) => sum + (a.tokens ?? 0), 0)
    return { ...task, agents, agentCount, totalTokens }
  })
}

export function registerWorkflowAgentController(
  taskId: string,
  agentId: string,
  controller: AbortController,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.set(agentId, controller)
    return task // Map mutated in place; identity preserved (no listener fire)
  })
}

export function clearWorkflowAgentController(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.delete(agentId)
    return task
  })
}

export function completeWorkflowTask(
  taskId: string,
  opts: { summary?: string; totalTokens?: number; agentCount?: number },
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'completed',
    endTime: Date.now(),
    notified: true,
    summary: opts.summary ?? task.summary,
    totalTokens: opts.totalTokens ?? task.totalTokens,
    agentCount: opts.agentCount ?? task.agentCount,
    abortController: undefined,
  }))
}

export function failWorkflowTask(
  taskId: string,
  error: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => ({
    ...task,
    status: 'failed',
    endTime: Date.now(),
    notified: true,
    summary: task.summary ?? error,
    abortController: undefined,
  }))
}

export function killWorkflowTask(taskId: string, setAppState: SetAppState): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    if (task.status !== 'running') return task
    task.abortController?.abort()
    for (const c of task.agentControllers.values()) c.abort()
    return {
      ...task,
      status: 'killed',
      endTime: Date.now(),
      notified: true,
      abortController: undefined,
    }
  })
}

/** Abort a single running agent — it resolves to null in the script. */
export function skipWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.get(agentId)?.abort()
    return task
  })
}

/** Best-effort retry: abort the current attempt (the port does not re-run
 *  externally; surfaced for parity with the upstream control surface). */
export function retryWorkflowAgent(
  taskId: string,
  agentId: string,
  setAppState: SetAppState,
): void {
  updateTaskState<LocalWorkflowTaskState>(taskId, setAppState, task => {
    task.agentControllers.get(agentId)?.abort()
    return task
  })
}

export const LocalWorkflowTask: Task = {
  name: 'LocalWorkflowTask',
  type: 'local_workflow',
  async kill(taskId, setAppState) {
    killWorkflowTask(taskId, setAppState)
  },
}
