import type { TaskGraph } from '../../tasks/graph/taskGraph.js'
import { openTaskGraph } from '../../tasks/graph/taskGraph.js'
import type {
  OverlapDecision,
  TaskIsolation,
  TaskRecord,
} from '../../tasks/graph/index.js'
import { AbortError } from '../../utils/errors.js'
import type { WorkerEffort } from '../../utils/swarm/backends/types.js'
import {
  acquireSwarmWorkerSlot,
  type SwarmWorkerLease,
} from '../../utils/swarm/concurrencyPolicy.js'

const DEFAULT_DEPENDENCY_POLL_MS = 100
const DEFAULT_TASK_LEASE_TTL_MS = 6 * 60 * 60 * 1_000

export type WorkerExecutionInput = {
  taskId: string
  owner: string
  schedulerScope: string
  effort: WorkerEffort
  filesTouched?: readonly string[]
  readSet?: readonly string[]
  writeSet?: readonly string[]
  blockedBy?: readonly string[]
  isolation?: TaskIsolation
  signal?: AbortSignal
}

export type WorkerExecutionDependencies = {
  graph?: TaskGraph
  acquireSchedulerLease?: (
    scope: string,
    effort: WorkerEffort,
    signal?: AbortSignal,
  ) => Promise<SwarmWorkerLease>
  dependencyPollMs?: number
  taskLeaseTtlMs?: number
}

export type WorkerExecutionLease = {
  taskId: string
  owner: string
  effort: WorkerEffort
  routeDecision: OverlapDecision
  getTask: () => TaskRecord | null
  complete: () => void
  fail: () => void
  release: () => void
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('worker lifecycle timing values must be positive integers')
  }
  return value
}

function configuredTaskLeaseTtl(): number {
  const raw = process.env.MINDCODE_TASK_LEASE_TTL_MS?.trim()
  if (!raw) return DEFAULT_TASK_LEASE_TTL_MS
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0
    ? value
    : DEFAULT_TASK_LEASE_TTL_MS
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError()
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new AbortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function assertTaskIdentity(value: string, field: string): string {
  const normalized = value.trim()
  if (!normalized || normalized.length > 256) {
    throw new Error(`${field} must be between 1 and 256 characters`)
  }
  return normalized
}

/**
 * Implements Route -> atomic claim -> weighted scheduler acquire. The returned
 * lease owns both the SQLite task lease and the scheduler cost lease.
 */
export async function acquireWorkerExecution(
  input: WorkerExecutionInput,
  dependencies: WorkerExecutionDependencies = {},
): Promise<WorkerExecutionLease> {
  throwIfAborted(input.signal)
  const taskId = assertTaskIdentity(input.taskId, 'taskId')
  const owner = assertTaskIdentity(input.owner, 'owner')
  const schedulerScope = assertTaskIdentity(
    input.schedulerScope,
    'schedulerScope',
  )
  const graph = dependencies.graph ?? openTaskGraph()
  const ownsGraph = dependencies.graph === undefined
  const dependencyPollMs = positiveInteger(
    dependencies.dependencyPollMs,
    DEFAULT_DEPENDENCY_POLL_MS,
  )
  const taskLeaseTtlMs = positiveInteger(
    dependencies.taskLeaseTtlMs,
    configuredTaskLeaseTtl(),
  )
  const acquireScheduler =
    dependencies.acquireSchedulerLease ??
    ((scope: string, effort: WorkerEffort, signal?: AbortSignal) =>
      acquireSwarmWorkerSlot(scope, { effort, signal }))

  let graphLeaseId: string | undefined
  let schedulerLease: SwarmWorkerLease | undefined
  let closed = false
  let terminal = false

  const closeGraph = () => {
    if (ownsGraph && !closed) {
      closed = true
      graph.close()
    }
  }

  try {
    const routed = graph.route({
      id: taskId,
      idempotency_key: `agent-lifecycle:${taskId}`,
      files_touched: input.filesTouched,
      read_set: input.readSet,
      write_set: input.writeSet,
      blocked_by: input.blockedBy,
      isolation: input.isolation ?? 'shared',
    })
    if (!routed.task || !routed.decision.allowed) {
      throw new Error(`Task ${taskId} was rejected by overlap validation`)
    }

    while (graphLeaseId === undefined) {
      throwIfAborted(input.signal)
      const claim = graph.claimTask(taskId, owner, {
        ttl_ms: taskLeaseTtlMs,
      })
      if (claim.ok) {
        graphLeaseId = claim.lease.lease_id
        break
      }
      if (
        claim.reason !== 'dependencies_incomplete' &&
        claim.reason !== 'version_conflict'
      ) {
        throw new Error(
          `Task ${taskId} cannot be claimed: ${claim.reason}`,
        )
      }
      await abortableDelay(dependencyPollMs, input.signal)
    }

    schedulerLease = await acquireScheduler(
      schedulerScope,
      input.effort,
      input.signal,
    )

    const claimed = graph.requireTask(taskId)
    if (claimed.owner !== owner || claimed.lease_id !== graphLeaseId) {
      throw new Error(`Task ${taskId} lost its claim before execution`)
    }
    graph.update(taskId, { status: 'running' }, claimed.version)

    const finish = (status: 'completed' | 'failed') => {
      if (terminal) return
      terminal = true
      try {
        const current = graph.read(taskId)
        if (
          current &&
          current.owner === owner &&
          current.lease_id === graphLeaseId &&
          (current.status === 'claimed' || current.status === 'running')
        ) {
          graph.update(taskId, { status }, current.version)
        }
        if (graphLeaseId) {
          graph.releaseLease(graphLeaseId, { owner })
          graphLeaseId = undefined
        }
      } finally {
        schedulerLease?.release()
        schedulerLease = undefined
        closeGraph()
      }
    }

    const release = () => {
      if (terminal) return
      terminal = true
      try {
        if (graphLeaseId) {
          graph.releaseLease(graphLeaseId, { owner })
          graphLeaseId = undefined
        }
      } finally {
        schedulerLease?.release()
        schedulerLease = undefined
        closeGraph()
      }
    }

    return {
      taskId,
      owner,
      effort: input.effort,
      routeDecision: routed.decision,
      getTask: () => (closed ? null : graph.read(taskId)),
      complete: () => finish('completed'),
      fail: () => finish('failed'),
      release,
    }
  } catch (error) {
    try {
      if (graphLeaseId) graph.releaseLease(graphLeaseId, { owner })
    } finally {
      schedulerLease?.release()
      closeGraph()
    }
    throw error
  }
}
