import { createHash, randomUUID } from 'node:crypto'
import {
  type WorkerTaskGraph,
  createWorkerTaskGraph,
} from '../../runtime/taskGraph/workerGraph.js'
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
const DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS = 60_000
const DEFAULT_SCHEDULER_WAIT_TIMEOUT_MS = 30_000
const DEFAULT_TASK_LEASE_TTL_MS = 6 * 60 * 60 * 1_000
const RUNTIME_TASK_PREFIX = 'mindcode-agent-runtime:'
const TARGET_SCOPE_ROOT = '.mindcode-target-scope'
const WORKER_RUNTIME_TOKEN = randomUUID()

export type WorkerExecutionPhase =
  | 'routing'
  | 'resolving_dependencies'
  | 'waiting_dependency'
  | 'waiting_scheduler'
  | 'starting'

export type ExternalDependencyStatus =
  | 'completed'
  | 'incomplete'
  | 'failed'
  | 'missing'

export class WorkerLifecycleTimeoutError extends Error {
  readonly phase: 'dependency' | 'scheduler'
  readonly timeoutMs: number

  constructor(
    phase: 'dependency' | 'scheduler',
    timeoutMs: number,
    detail: string,
  ) {
    super(`Worker ${phase} wait timed out after ${timeoutMs}ms: ${detail}`)
    this.name = 'WorkerLifecycleTimeoutError'
    this.phase = phase
    this.timeoutMs = timeoutMs
  }
}

export type WorkerCompletionEvidence = {
  reportId: string
  policyEpoch: number
  policyDigest?: string
}

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
  runtimeScope?: string
  targetScope?: string
  /** Immutable compiled Worker policy identity captured at admission. */
  policyEpoch?: number
  policyDigest?: string
  signal?: AbortSignal
  onPhase?: (phase: WorkerExecutionPhase, detail?: string) => void
}

export type WorkerExecutionDependencies = {
  /** Async graph seam. Production leaves this unset and uses daemon RPC. */
  graph?: WorkerTaskGraph
  /** Set when the caller owns an explicitly injected graph. */
  closeGraph?: boolean
  acquireSchedulerLease?: (
    scope: string,
    effort: WorkerEffort,
    signal?: AbortSignal,
  ) => Promise<SwarmWorkerLease>
  resolveExternalDependency?: (
    taskId: string,
  ) => Promise<ExternalDependencyStatus>
  dependencyPollMs?: number
  dependencyWaitTimeoutMs?: number
  schedulerWaitTimeoutMs?: number
  taskLeaseTtlMs?: number
  taskLeaseHeartbeat?: (
    heartbeat: () => void | Promise<void>,
    intervalMs: number,
  ) => () => void
}

export type WorkerExecutionLease = {
  taskId: string
  owner: string
  effort: WorkerEffort
  routeDecision: OverlapDecision
  policyEpoch?: number
  policyDigest?: string
  getTask: () => Promise<TaskRecord | null>
  complete: (evidence?: WorkerCompletionEvidence) => Promise<void>
  fail: (evidence?: WorkerCompletionEvidence) => Promise<void>
  release: () => Promise<void>
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('worker lifecycle timing values must be positive integers')
  }
  return value
}

function configuredPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : fallback
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

const WORKER_REPORT_ID_PATTERN = /^[a-f0-9]{64}$/

function validatePolicyIdentity(
  policyEpoch: number | undefined,
  policyDigest: string | undefined,
): void {
  if (policyEpoch === undefined && policyDigest === undefined) return
  if (
    policyEpoch === undefined ||
    !Number.isSafeInteger(policyEpoch) ||
    policyEpoch < 0
  ) {
    throw new Error('worker policy epoch must be a nonnegative safe integer')
  }
  if (
    policyDigest === undefined ||
    !WORKER_REPORT_ID_PATTERN.test(policyDigest)
  ) {
    throw new Error('worker policy digest must be a lowercase SHA-256 digest')
  }
}

function validateTerminalEvidence(
  evidence: WorkerCompletionEvidence | undefined,
  expectedPolicyEpoch: number | undefined,
  expectedPolicyDigest: string | undefined,
): WorkerCompletionEvidence | undefined {
  if (expectedPolicyEpoch === undefined) {
    if (evidence === undefined) return undefined
    if (!WORKER_REPORT_ID_PATTERN.test(evidence.reportId)) {
      throw new Error('worker report_id must be a lowercase SHA-256 digest')
    }
    if (
      !Number.isSafeInteger(evidence.policyEpoch) ||
      evidence.policyEpoch < 0
    ) {
      throw new Error(
        'worker report policy epoch must be a nonnegative safe integer',
      )
    }
    if (
      evidence.policyDigest !== undefined &&
      !WORKER_REPORT_ID_PATTERN.test(evidence.policyDigest)
    ) {
      throw new Error(
        'worker report policy digest must be a lowercase SHA-256 digest',
      )
    }
    return evidence
  }

  if (evidence === undefined) {
    throw new Error(
      'worker completion requires a validated report_id and policy_epoch',
    )
  }
  if (!WORKER_REPORT_ID_PATTERN.test(evidence.reportId)) {
    throw new Error('worker report_id must be a lowercase SHA-256 digest')
  }
  if (evidence.policyEpoch !== expectedPolicyEpoch) {
    throw new Error(
      `stale or mismatched worker report policy epoch: expected ${expectedPolicyEpoch}, received ${evidence.policyEpoch}`,
    )
  }
  if (
    expectedPolicyDigest !== undefined &&
    evidence.policyDigest !== expectedPolicyDigest
  ) {
    throw new Error('stale or mismatched worker report policy digest')
  }
  return evidence
}

function runtimeHash(runtimeScope: string): string {
  return createHash('sha256').update(runtimeScope).digest('hex').slice(0, 24)
}

function runtimeTaskPrefix(runtimeScope: string): string {
  return `${RUNTIME_TASK_PREFIX}${runtimeHash(runtimeScope)}:`
}

function namespaceTaskId(
  taskId: string,
  runtimeScope: string | undefined,
): string {
  if (!runtimeScope) return taskId
  const prefix = runtimeTaskPrefix(runtimeScope)
  if (taskId.startsWith(prefix)) return taskId
  return `${prefix}${Buffer.from(taskId, 'utf8').toString('base64url')}`
}

function publicTaskId(
  taskId: string,
  runtimeScope: string | undefined,
): string {
  const currentPrefix = runtimeScope
    ? runtimeTaskPrefix(runtimeScope)
    : undefined
  const encoded = currentPrefix && taskId.startsWith(currentPrefix)
    ? taskId.slice(currentPrefix.length)
    : taskId.startsWith(RUNTIME_TASK_PREFIX)
      ? taskId.slice(taskId.lastIndexOf(':') + 1)
      : undefined
  if (encoded === undefined) return taskId
  try {
    return Buffer.from(encoded, 'base64url').toString('utf8')
  } catch {
    return taskId
  }
}

function targetScopePrefix(targetScope: string): string {
  return `${TARGET_SCOPE_ROOT}/${runtimeHash(targetScope)}/`
}

function namespaceTarget(
  target: string,
  targetScope: string | undefined,
): string {
  if (!targetScope) return target
  const prefix = targetScopePrefix(targetScope)
  return target.startsWith(prefix) ? target : `${prefix}${target}`
}

function publicTarget(
  target: string,
  targetScope: string | undefined,
): string {
  if (!targetScope) return target
  const prefix = targetScopePrefix(targetScope)
  return target.startsWith(prefix) ? target.slice(prefix.length) : target
}

function namespaceTargets(
  targets: readonly string[] | undefined,
  targetScope: string | undefined,
): string[] | undefined {
  return targets?.map(target => namespaceTarget(target, targetScope))
}

function publicTaskRecord(
  task: TaskRecord | null,
  runtimeScope: string | undefined,
  targetScope: string | undefined,
): TaskRecord | null {
  if (!task) return task
  return {
    ...task,
    id: publicTaskId(task.id, runtimeScope),
    blocked_by: task.blocked_by.map(id => publicTaskId(id, runtimeScope)),
    files_touched: task.files_touched.map(path =>
      publicTarget(path, targetScope),
    ),
    read_set: task.read_set.map(path => publicTarget(path, targetScope)),
    write_set: task.write_set.map(path => publicTarget(path, targetScope)),
  }
}

function publicOverlapDecision(
  decision: OverlapDecision,
  runtimeScope: string | undefined,
  targetScope: string | undefined,
): OverlapDecision {
  return {
    ...decision,
    blocked_by: decision.blocked_by.map(id =>
      publicTaskId(id, runtimeScope),
    ),
    conflicts: decision.conflicts.map(conflict => ({
      ...conflict,
      task_id: publicTaskId(conflict.task_id, runtimeScope),
      paths: conflict.paths.map(path => publicTarget(path, targetScope)),
    })),
  }
}

function emitPhase(
  input: WorkerExecutionInput,
  phase: WorkerExecutionPhase,
  detail?: string,
): void {
  try {
    input.onPhase?.(phase, detail)
  } catch {
    // UI progress must never break lifecycle state transitions.
  }
}

async function resolveExternalDependencyWithDeadline(
  resolveExternalDependency: NonNullable<
    WorkerExecutionDependencies['resolveExternalDependency']
  >,
  dependencyId: string,
  signal: AbortSignal | undefined,
  dependencyDeadline: number,
  dependencyWaitTimeoutMs: number,
): Promise<ExternalDependencyStatus> {
  throwIfAborted(signal)
  const remaining = dependencyDeadline - Date.now()
  if (remaining <= 0) {
    throw new WorkerLifecycleTimeoutError(
      'dependency',
      dependencyWaitTimeoutMs,
      dependencyId,
    )
  }

  return await new Promise<ExternalDependencyStatus>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
    const resolveOnce = (status: ExternalDependencyStatus) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(status)
    }
    const rejectOnce = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    const onAbort = () => rejectOnce(new AbortError())
    const timer = setTimeout(
      () =>
        rejectOnce(
          new WorkerLifecycleTimeoutError(
            'dependency',
            dependencyWaitTimeoutMs,
            dependencyId,
          ),
        ),
      remaining,
    )
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => resolveExternalDependency(dependencyId))
      .then(resolveOnce, rejectOnce)
  })
}

async function resolveDependencies(
  blockedBy: readonly string[] | undefined,
  runtimeScope: string | undefined,
  graph: WorkerTaskGraph,
  resolveExternalDependency:
    | WorkerExecutionDependencies['resolveExternalDependency']
    | undefined,
  taskId: string,
  input: WorkerExecutionInput,
  dependencyPollMs: number,
  dependencyWaitTimeoutMs: number,
  dependencyDeadline: number,
): Promise<string[] | undefined> {
  if (blockedBy === undefined) return undefined
  const resolved: string[] = []
  for (const dependency of blockedBy) {
    const dependencyId = assertTaskIdentity(dependency, 'blockedBy task ID')
    const storedDependencyId = namespaceTaskId(dependencyId, runtimeScope)
    const lifecycleDependency = await graph.read(
      storedDependencyId,
      input.signal,
    )
    if (lifecycleDependency) {
      if (
        lifecycleDependency.status === 'failed' ||
        lifecycleDependency.status === 'cancelled'
      ) {
        throw new Error(
          `Task ${taskId} depends on failed task ${dependencyId}`,
        )
      }
      resolved.push(storedDependencyId)
      continue
    }
    if (!resolveExternalDependency) {
      resolved.push(storedDependencyId)
      continue
    }

    let announcedWait = false
    while (true) {
      throwIfAborted(input.signal)
      const status = await resolveExternalDependencyWithDeadline(
        resolveExternalDependency,
        dependencyId,
        input.signal,
        dependencyDeadline,
        dependencyWaitTimeoutMs,
      )
      if (status === 'completed') break
      if (status === 'missing') {
        throw new Error(
          `Task ${taskId} references missing dependency ${dependencyId}`,
        )
      }
      if (status === 'failed') {
        throw new Error(
          `Task ${taskId} depends on failed task ${dependencyId}`,
        )
      }
      if (!announcedWait) {
        emitPhase(input, 'waiting_dependency', dependencyId)
        announcedWait = true
      }
      const remaining = dependencyDeadline - Date.now()
      if (remaining <= 0) {
        throw new WorkerLifecycleTimeoutError(
          'dependency',
          dependencyWaitTimeoutMs,
          dependencyId,
        )
      }
      await abortableDelay(
        Math.min(dependencyPollMs, remaining),
        input.signal,
      )
    }
  }
  return resolved
}

async function acquireSchedulerWithTimeout(
  acquireScheduler: NonNullable<
    WorkerExecutionDependencies['acquireSchedulerLease']
  >,
  schedulerScope: string,
  effort: WorkerEffort,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<SwarmWorkerLease> {
  throwIfAborted(signal)
  const controller = new AbortController()
  let cancellationError: Error | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  const cancellation = new Promise<never>((_resolve, reject) => {
    const cancel = (error: Error) => {
      if (cancellationError) return
      cancellationError = error
      controller.abort()
      reject(error)
    }
    onAbort = () => cancel(new AbortError())
    signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(
      () =>
        cancel(
          new WorkerLifecycleTimeoutError(
            'scheduler',
            timeoutMs,
            `scope ${schedulerScope}`,
          ),
        ),
      timeoutMs,
    )
  })

  const acquisition = Promise.resolve().then(() => acquireScheduler(
    schedulerScope,
    effort,
    controller.signal,
  )).then(lease => {
    if (cancellationError) {
      lease.release()
      throw cancellationError
    }
    return lease
  }).catch(error => {
    throw cancellationError ?? error
  })

  try {
    return await Promise.race([acquisition, cancellation])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * Stable inside this process/session and different after a restart, preventing
 * stale lifecycle rows and orphan leases from blocking a fresh runtime.
 */
export function getWorkerRuntimeScope(sessionId: string, cwd: string): string {
  return `${sessionId}\u0000${cwd}\u0000${WORKER_RUNTIME_TOKEN}`
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
  const runtimeScope = input.runtimeScope?.trim() || undefined
  const targetScope = input.targetScope?.trim() || undefined
  validatePolicyIdentity(input.policyEpoch, input.policyDigest)
  const storedTaskId = namespaceTaskId(taskId, runtimeScope)
  const dependencyPollMs = positiveInteger(
    dependencies.dependencyPollMs,
    DEFAULT_DEPENDENCY_POLL_MS,
  )
  const dependencyWaitTimeoutMs = positiveInteger(
    dependencies.dependencyWaitTimeoutMs,
    configuredPositiveInteger(
      'MINDCODE_AGENT_DEPENDENCY_TIMEOUT_MS',
      DEFAULT_DEPENDENCY_WAIT_TIMEOUT_MS,
    ),
  )
  const schedulerWaitTimeoutMs = positiveInteger(
    dependencies.schedulerWaitTimeoutMs,
    configuredPositiveInteger(
      'MINDCODE_AGENT_SCHEDULER_TIMEOUT_MS',
      DEFAULT_SCHEDULER_WAIT_TIMEOUT_MS,
    ),
  )
  const taskLeaseTtlMs = positiveInteger(
    dependencies.taskLeaseTtlMs,
    configuredPositiveInteger(
      'MINDCODE_TASK_LEASE_TTL_MS',
      DEFAULT_TASK_LEASE_TTL_MS,
    ),
  )
  const acquireScheduler =
    dependencies.acquireSchedulerLease ??
    ((scope: string, effort: WorkerEffort, signal?: AbortSignal) =>
      acquireSwarmWorkerSlot(scope, { effort, signal }))

  // Production always starts with the daemon-backed async adapter. The local
  // SQLite authority is selected lazily by the adapter only for a classified
  // pre-dispatch availability failure. Tests may inject an explicit async
  // wrapper around a TaskGraph through dependencies.graph.
  const graph =
    dependencies.graph ??
    // The adapter passes the admission signal to pre-dispatch operations;
    // terminal cleanup deliberately uses no signal so leases are released
    // even after the parent turn is cancelled.
    createWorkerTaskGraph()
  const ownsGraph =
    dependencies.graph === undefined || dependencies.closeGraph === true

  let graphLeaseId: string | undefined
  let schedulerLease: SwarmWorkerLease | undefined
  let routedCreated = false
  let closed = false
  let terminal = false
  let heartbeatActive = false
  let stopScheduledHeartbeat: (() => void) | undefined

  const closeGraph = async () => {
    if (ownsGraph && !closed) {
      closed = true
      await graph.close()
    }
  }

  const stopHeartbeat = () => {
    if (!heartbeatActive) return
    heartbeatActive = false
    stopScheduledHeartbeat?.()
    stopScheduledHeartbeat = undefined
  }

  const heartbeat = async () => {
    if (!heartbeatActive || terminal || graphLeaseId === undefined) return
    const leaseId = graphLeaseId
    try {
      const renewed = await graph.renewLease(leaseId, {
        owner,
        ttl_ms: taskLeaseTtlMs,
      })
      if (renewed === null || renewed.released_at !== null) {
        graphLeaseId = undefined
        stopHeartbeat()
        return
      }
      if (!heartbeatActive || terminal || graphLeaseId !== leaseId) {
        return
      }
    } catch {
      // Keep the heartbeat alive for transient daemon/SQLite failures. An
      // ambiguous mutation is never redirected to the other authority.
    }
  }

  const startHeartbeat = () => {
    if (
      heartbeatActive ||
      terminal ||
      graphLeaseId === undefined
    ) return
    heartbeatActive = true
    const schedule = dependencies.taskLeaseHeartbeat ?? ((callback: () => void | Promise<void>, intervalMs: number) => {
      const timer = setInterval(() => {
        void callback()
      }, intervalMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
    stopScheduledHeartbeat = schedule(
      heartbeat,
      Math.max(1, Math.floor(taskLeaseTtlMs / 3)),
    )
  }

  const failNonTerminalTask = async () => {
    const current = await graph.read(storedTaskId)
    if (!current) return
    const ownsClaim =
      graphLeaseId !== undefined &&
      current.owner === owner &&
      current.lease_id === graphLeaseId &&
      (current.status === 'claimed' || current.status === 'running')
    const ownsUnclaimedRoute =
      routedCreated &&
      graphLeaseId === undefined &&
      current.status === 'pending' &&
      current.owner === null &&
      current.lease_id === null
    if (ownsClaim || ownsUnclaimedRoute) {
      await graph.update(storedTaskId, { status: 'failed' }, current.version)
    }
  }

  try {
    const dependencyDeadline = Date.now() + dependencyWaitTimeoutMs
    emitPhase(input, 'resolving_dependencies')
    const resolvedBlockedBy = await resolveDependencies(
      input.blockedBy,
      runtimeScope,
      graph,
      dependencies.resolveExternalDependency,
      taskId,
      input,
      dependencyPollMs,
      dependencyWaitTimeoutMs,
      dependencyDeadline,
    )
    throwIfAborted(input.signal)

    emitPhase(input, 'routing')
    const routed = await graph.route({
      id: storedTaskId,
      idempotency_key: `agent-lifecycle:${storedTaskId}`,
      // Task IDs are runtime-scoped to avoid stale-lease identity collisions.
      // Targets use a stable checkout scope: separate sessions in the same
      // cwd still conflict, while unrelated projects may use equal paths.
      files_touched: namespaceTargets(input.filesTouched, targetScope),
      read_set: namespaceTargets(input.readSet, targetScope),
      write_set: namespaceTargets(input.writeSet, targetScope),
      blocked_by: resolvedBlockedBy,
      isolation: input.isolation ?? 'shared',
      policy_epoch: input.policyEpoch,
    }, undefined, input.signal)
    if (!routed.task || !routed.decision.allowed) {
      throw new Error(`Task ${taskId} was rejected by overlap validation`)
    }
    if (
      input.policyEpoch !== undefined &&
      routed.task.policy_epoch !== input.policyEpoch
    ) {
      throw new Error(
        `Task ${taskId} has stale worker policy epoch ${routed.task.policy_epoch}; expected ${input.policyEpoch}`,
      )
    }
    routedCreated = routed.created

    let announcedDependencyWait = false
    while (graphLeaseId === undefined) {
      throwIfAborted(input.signal)
      const claim = await graph.claimTask(
        storedTaskId,
        owner,
        { ttl_ms: taskLeaseTtlMs },
        input.signal,
      )
      if (claim.ok) {
        graphLeaseId = claim.lease.lease_id
        startHeartbeat()
        break
      }
      if (
        claim.reason !== 'dependencies_incomplete' &&
        claim.reason !== 'version_conflict'
      ) {
        throw new Error(`Task ${taskId} cannot be claimed: ${claim.reason}`)
      }

      const blockers = claim.blocked_by
        .map(id => publicTaskId(id, runtimeScope))
        .join(', ')
      if (!announcedDependencyWait) {
        emitPhase(input, 'waiting_dependency', blockers || undefined)
        announcedDependencyWait = true
      }
      const remaining = dependencyDeadline - Date.now()
      if (remaining <= 0) {
        throw new WorkerLifecycleTimeoutError(
          'dependency',
          dependencyWaitTimeoutMs,
          blockers || taskId,
        )
      }
      await abortableDelay(Math.min(dependencyPollMs, remaining), input.signal)
    }

    emitPhase(input, 'waiting_scheduler')
    schedulerLease = await acquireSchedulerWithTimeout(
      acquireScheduler,
      schedulerScope,
      input.effort,
      input.signal,
      schedulerWaitTimeoutMs,
    )

    throwIfAborted(input.signal)
    const claimed = await graph.requireTask(storedTaskId, input.signal)
    if (claimed.owner !== owner || claimed.lease_id !== graphLeaseId) {
      throw new Error(`Task ${taskId} lost its claim before execution`)
    }
    // Once the worker owns a scheduler and graph lease, terminal cleanup must
    // survive cancellation of the parent turn.
    await graph.update(storedTaskId, { status: 'running' }, claimed.version)
    emitPhase(input, 'starting')

    const finish = (
      status: 'completed' | 'failed',
      evidence?: WorkerCompletionEvidence,
    ): Promise<void> => {
      if (terminal) return Promise.resolve()
      const terminalEvidence = validateTerminalEvidence(
        evidence,
        input.policyEpoch,
        input.policyDigest,
      )
      terminal = true
      stopHeartbeat()
      return (async () => {
        try {
          let operationError: unknown
          try {
            const current = await graph.read(storedTaskId)
            if (
              current &&
              current.owner === owner &&
              current.lease_id === graphLeaseId &&
              (current.status === 'claimed' || current.status === 'running')
            ) {
              await graph.update(
                storedTaskId,
                {
                  status,
                  ...(terminalEvidence
                    ? {
                        policy_epoch: terminalEvidence.policyEpoch,
                        report_id: terminalEvidence.reportId,
                      }
                    : {}),
                },
                current.version,
              )
            }
          } catch (error) {
            operationError = error
          }
          try {
            // Lease release is attempted even when report persistence fails,
            // but it remains on the selected authority and is never retried
            // through the other backend.
            if (graphLeaseId) {
              await graph.releaseLease(graphLeaseId, { owner })
            }
          } catch (error) {
            operationError ??= error
          } finally {
            graphLeaseId = undefined
          }
          if (operationError) {
            throw operationError
          }
        } finally {
          schedulerLease?.release()
          schedulerLease = undefined
          await closeGraph()
        }
      })()
    }

    const release = (): Promise<void> => {
      if (terminal) return Promise.resolve()
      terminal = true
      stopHeartbeat()
      return (async () => {
        try {
          let releaseError: unknown
          if (graphLeaseId) {
            try {
              await graph.releaseLease(graphLeaseId, { owner })
            } catch (error) {
              releaseError = error
            } finally {
              graphLeaseId = undefined
            }
          }
          if (releaseError) {
            throw releaseError
          }
        } finally {
          schedulerLease?.release()
          schedulerLease = undefined
          await closeGraph()
        }
      })()
    }

    return {
      taskId,
      owner,
      effort: input.effort,
      policyEpoch: input.policyEpoch,
      policyDigest: input.policyDigest,
      routeDecision: publicOverlapDecision(
        routed.decision,
        runtimeScope,
        targetScope,
      ),
      getTask: async () =>
        closed
          ? null
          : publicTaskRecord(
              await graph.read(storedTaskId),
              runtimeScope,
              targetScope,
            ),
      complete: evidence => finish('completed', evidence),
      fail: evidence => finish('failed', evidence),
      release,
    }
  } catch (error) {
    stopHeartbeat()
    try {
      if (!(error instanceof AbortError) && !input.signal?.aborted) {
        try {
          await failNonTerminalTask()
        } catch {
          // A racing update must not prevent lease cleanup.
        }
      }
      if (graphLeaseId) {
        try {
          await graph.releaseLease(graphLeaseId, { owner })
        } catch {
          // Do not switch graph authorities while recovering from an
          // ambiguous mutation. The original admission error remains primary.
        }
        graphLeaseId = undefined
      }
    } finally {
      schedulerLease?.release()
      await closeGraph()
    }
    throw error
  }
}
