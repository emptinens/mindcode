import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod/v4'
import { getIsNonInteractiveSession, getSessionId } from '../bootstrap/state.js'
import { getMindCodeConfigHomeDir, getTeamsDir, isEnvTruthy } from './envUtils.js'
import { lazySchema } from './lazySchema.js'
import { createSignal } from './signal.js'
import { getTeamName } from './teammate.js'
import { getTeammateContext } from './teammateContext.js'
import {
  graphBlockTask,
  graphClaimTask,
  graphCreateTask,
  graphDeleteTask,
  graphGetTask,
  graphListTasks,
  graphResetTaskList,
  graphUpdateTask,
  type BridgeTaskPatch,
} from './taskGraphAdapter.js'

const tasksUpdated = createSignal()
let leaderTeamName: string | undefined

export function setLeaderTeamName(teamName: string): void {
  if (leaderTeamName === teamName) return
  leaderTeamName = teamName
  notifyTasksUpdated()
}

export function clearLeaderTeamName(): void {
  if (leaderTeamName === undefined) return
  leaderTeamName = undefined
  notifyTasksUpdated()
}

export const onTasksUpdated = tasksUpdated.subscribe

export function notifyTasksUpdated(): void {
  try {
    tasksUpdated.emit()
  } catch {
    // UI listeners must never break a task mutation.
  }
}

// `in_progress` remains accepted at the compatibility boundary. SQLite stores
// only the canonical team statuses: pending, claimed, running, completed, failed.
export const TASK_STATUSES = [
  'pending',
  'claimed',
  'running',
  'completed',
  'failed',
] as const

export const TaskStatusSchema = lazySchema(() =>
  z.enum([...TASK_STATUSES, 'in_progress'] as const),
)
export type TaskStatus = z.infer<ReturnType<typeof TaskStatusSchema>>

export const TaskSchema = lazySchema(() =>
  z.object({
    id: z.string(),
    subject: z.string(),
    description: z.string(),
    activeForm: z.string().optional(),
    owner: z.string().optional(),
    status: TaskStatusSchema(),
    blocks: z.array(z.string()),
    blockedBy: z.array(z.string()),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
)
export type Task = z.infer<ReturnType<typeof TaskSchema>>

export function isTodoV2Enabled(): boolean {
  if (isEnvTruthy(process.env.MINDCODE_ENABLE_TASKS)) return true
  return !getIsNonInteractiveSession()
}

export async function resetTaskList(taskListId: string): Promise<void> {
  await graphResetTaskList(taskListId)
  notifyTasksUpdated()
}

export function getTaskListId(): string {
  if (process.env.MINDCODE_TASK_LIST_ID) return process.env.MINDCODE_TASK_LIST_ID
  const teammateContext = getTeammateContext()
  if (teammateContext) return teammateContext.teamName
  return getTeamName() || leaderTeamName || getSessionId()
}

export function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, '-')
}

// Retained for the file-watcher/UI compatibility layer. Task contents are no
// longer stored here; the SQLite graph is authoritative.
export function getTasksDir(taskListId: string): string {
  return join(getMindCodeConfigHomeDir(), 'tasks', sanitizePathComponent(taskListId))
}

export function getTaskPath(taskListId: string, taskId: string): string {
  return join(getTasksDir(taskListId), `${sanitizePathComponent(taskId)}.json`)
}

export async function ensureTasksDir(taskListId: string): Promise<void> {
  await mkdir(getTasksDir(taskListId), { recursive: true })
}

export async function createTask(
  taskListId: string,
  taskData: Omit<Task, 'id'>,
): Promise<string> {
  const id = await graphCreateTask(taskListId, {
    ...taskData,
    status: taskData.status ?? 'pending',
    blocks: taskData.blocks ?? [],
    blockedBy: taskData.blockedBy ?? [],
  })
  notifyTasksUpdated()
  return id
}

export async function getTask(taskListId: string, taskId: string): Promise<Task | null> {
  return graphGetTask(taskListId, taskId)
}

function toGraphPatch(updates: Partial<Omit<Task, 'id'>>): BridgeTaskPatch {
  return {
    subject: updates.subject,
    description: updates.description,
    activeForm: updates.activeForm,
    status: updates.status,
    owner: Object.prototype.hasOwnProperty.call(updates, 'owner')
      ? updates.owner ?? null
      : undefined,
    blockedBy: updates.blockedBy,
    metadata: updates.metadata,
  }
}

export async function updateTask(
  taskListId: string,
  taskId: string,
  updates: Partial<Omit<Task, 'id'>>,
): Promise<Task | null> {
  const result = await graphUpdateTask(taskListId, taskId, toGraphPatch(updates))
  if (result) notifyTasksUpdated()
  return result
}

export async function deleteTask(taskListId: string, taskId: string): Promise<boolean> {
  const deleted = await graphDeleteTask(taskListId, taskId)
  if (deleted) notifyTasksUpdated()
  return deleted
}

export async function listTasks(taskListId: string): Promise<Task[]> {
  return graphListTasks(taskListId)
}

export async function blockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  const blocked = await graphBlockTask(taskListId, fromTaskId, toTaskId)
  if (blocked) notifyTasksUpdated()
  return blocked
}

export type ClaimTaskResult = {
  success: boolean
  reason?:
    | 'task_not_found'
    | 'already_claimed'
    | 'already_resolved'
    | 'blocked'
    | 'agent_busy'
  task?: Task
  busyWithTasks?: string[]
  blockedByTasks?: string[]
}

export type ClaimTaskOptions = { checkAgentBusy?: boolean }

export async function claimTask(
  taskListId: string,
  taskId: string,
  claimantAgentId: string,
  options: ClaimTaskOptions = {},
): Promise<ClaimTaskResult> {
  const result = await graphClaimTask(
    taskListId,
    taskId,
    claimantAgentId,
    options.checkAgentBusy,
  )
  if (result.success) {
    notifyTasksUpdated()
    return result
  }
  return result
}

export type TeamMember = {
  agentId: string
  name: string
  agentType?: string
}

export type AgentStatus = {
  agentId: string
  name: string
  agentType?: string
  status: 'idle' | 'busy'
  currentTasks: string[]
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
}

async function readTeamMembers(
  teamName: string,
): Promise<{ leadAgentId: string; members: TeamMember[] } | null> {
  const path = join(getTeamsDir(), sanitizeName(teamName), 'config.json')
  try {
    const content = await Bun.file(path).text()
    const team = JSON.parse(content) as { leadAgentId: string; members: TeamMember[] }
    return {
      leadAgentId: team.leadAgentId,
      members: team.members.map(member => ({
        agentId: member.agentId,
        name: member.name,
        agentType: member.agentType,
      })),
    }
  } catch {
    return null
  }
}

export async function getAgentStatuses(teamName: string): Promise<AgentStatus[] | null> {
  const team = await readTeamMembers(teamName)
  if (!team) return null
  const tasks = await listTasks(teamName)
  const unresolvedByOwner = new Map<string, string[]>()
  for (const task of tasks) {
    if (task.status !== 'completed' && task.status !== 'failed' && task.owner) {
      unresolvedByOwner.set(task.owner, [
        ...(unresolvedByOwner.get(task.owner) ?? []),
        task.id,
      ])
    }
  }
  return team.members.map(member => {
    const currentTasks = [
      ...(unresolvedByOwner.get(member.name) ?? []),
      ...(unresolvedByOwner.get(member.agentId) ?? []),
    ].filter((id, index, values) => values.indexOf(id) === index)
    return {
      agentId: member.agentId,
      name: member.name,
      agentType: member.agentType,
      status: currentTasks.length === 0 ? 'idle' : 'busy',
      currentTasks,
    }
  })
}

export type UnassignTasksResult = {
  unassignedTasks: Array<{ id: string; subject: string }>
  notificationMessage: string
}

export async function unassignTeammateTasks(
  teamName: string,
  teammateId: string,
  teammateName: string,
  reason: 'terminated' | 'shutdown',
): Promise<UnassignTasksResult> {
  const tasks = await listTasks(teamName)
  const assigned = tasks.filter(
    task =>
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      (task.owner === teammateId || task.owner === teammateName),
  )
  for (const task of assigned) {
    await updateTask(teamName, task.id, { owner: undefined, status: 'pending' })
  }
  const action = reason === 'terminated' ? 'was terminated' : 'has shut down'
  const names = assigned.map(task => `#${task.id} "${task.subject}"`).join(', ')
  const notificationMessage = `${teammateName} ${action}.${
    assigned.length > 0
      ? ` ${assigned.length} task(s) were unassigned: ${names}. Use TaskList to check availability and TaskUpdate with owner to reassign them to idle teammates.`
      : ''
  }`
  return {
    unassignedTasks: assigned.map(task => ({ id: task.id, subject: task.subject })),
    notificationMessage,
  }
}

export const DEFAULT_TASKS_MODE_TASK_LIST_ID = 'tasklist'
