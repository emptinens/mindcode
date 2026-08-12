import {
  type TaskGraph,
  TaskNotFoundError,
  openTaskGraph,
} from '../../tasks/graph/index.js'
import type {
  ClaimOptions,
  ClaimResult,
  RouteResult,
  RouteTaskInput,
  TaskLease,
  TaskRecord,
  TaskUpdate,
  RecoveryResult,
} from '../../tasks/graph/types.js'
import { AbortError } from '../../utils/errors.js'
import {
  DaemonCancelledError,
  DaemonClientError,
  DaemonDisabledError,
  DaemonDisconnectedError,
  DaemonTimeoutError,
} from '../daemon/errors.js'
import { TaskGraphDaemonClient } from './client.js'

/**
 * The deliberately small asynchronous graph surface used by a worker
 * lifecycle.  Keeping this separate from TaskGraph prevents production
 * lifecycle code from acquiring a synchronous SQLite handle.
 */
export type WorkerTaskGraph = {
  route: (
    task: RouteTaskInput,
    mode?: 'block' | 'reject',
    signal?: AbortSignal,
  ) => Promise<RouteResult>
  read: (taskId: string, signal?: AbortSignal) => Promise<TaskRecord | null>
  list: (signal?: AbortSignal) => Promise<TaskRecord[]>
  claimTask: (
    taskId: string,
    owner: string,
    options?: ClaimOptions,
    signal?: AbortSignal,
  ) => Promise<ClaimResult>
  requireTask: (taskId: string, signal?: AbortSignal) => Promise<TaskRecord>
  update: (
    taskId: string,
    patch: TaskUpdate,
    expectedVersion?: number,
    signal?: AbortSignal,
  ) => Promise<TaskRecord>
  renewLease: (
    leaseId: string,
    options?: {
      owner?: string
      ttl_ms?: number
      ttlMs?: number
      now?: string | Date
    },
    signal?: AbortSignal,
  ) => Promise<TaskLease | null>
  releaseLease: (
    leaseId: string,
    options?: { owner?: string; now?: string | Date },
    signal?: AbortSignal,
  ) => Promise<TaskLease | null>
  recover: (now?: string | Date, signal?: AbortSignal) => Promise<RecoveryResult>
  close: () => Promise<void>
}

export type WorkerTaskGraphDaemon = Pick<
  TaskGraphDaemonClient,
  | 'route'
  | 'read'
  | 'list'
  | 'claim'
  | 'update'
  | 'renewLease'
  | 'releaseLease'
  | 'recover'
>

export type WorkerTaskGraphOptions = {
  /** Injected in tests; production uses TaskGraphDaemonClient by default. */
  daemon?: WorkerTaskGraphDaemon
  /** Lazy local factory. It is called only after eligible pre-dispatch failure. */
  localFactory?: () => TaskGraph
}

type Backend = WorkerTaskGraph
type Authority = 'unselected' | 'daemon' | 'local'

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AbortError()
}

/**
 * Only failures which prove that no graph request was dispatched may select
 * the local authority. Request timeouts, disconnects after readiness,
 * cancellation, protocol errors, and remote errors are intentionally
 * fail-closed because their mutation outcome is ambiguous.
 */
export function isPreDispatchTaskGraphUnavailable(error: unknown): boolean {
  if (error instanceof DaemonDisabledError) return true
  if (error instanceof DaemonTimeoutError) {
    return error.kind === 'connect' || error.kind === 'handshake'
  }
  if (error instanceof DaemonDisconnectedError) return false
  if (error instanceof DaemonCancelledError) return false
  if (error instanceof DaemonClientError) {
    return (
      error.code === 'DAEMON_REQUEST_UNAVAILABLE' ||
      error.code === 'DAEMON_UNAVAILABLE'
    )
  }
  return false
}

function daemonBackend(client: WorkerTaskGraphDaemon): Backend {
  const read = async (
    taskId: string,
    signal?: AbortSignal,
  ): Promise<TaskRecord | null> => {
    throwIfAborted(signal)
    const result = await client.read(taskId, { signal })
    throwIfAborted(signal)
    return result.task
  }

  return {
    route: async (task, mode, signal) => {
      throwIfAborted(signal)
      const result =
        mode === undefined
          ? await client.route(task, undefined, { signal })
          : await client.route(task, mode, { signal })
      throwIfAborted(signal)
      return result
    },
    read,
    list: async signal => {
      throwIfAborted(signal)
      const result = await client.list({}, { signal })
      throwIfAborted(signal)
      return result.tasks
    },
    claimTask: async (taskId, owner, options, signal) => {
      throwIfAborted(signal)
      const claimOptions = options ?? {}
      const result = await client.claim(
        {
          task_id: taskId,
          owner,
          lease_id: claimOptions.lease_id ?? claimOptions.leaseId,
          ttl_ms: claimOptions.ttl_ms ?? claimOptions.ttlMs,
          expected_version:
            claimOptions.expected_version ?? claimOptions.expectedVersion,
          now: claimOptions.now,
        },
        { signal },
      )
      throwIfAborted(signal)
      return result
    },
    requireTask: async (taskId, signal) => {
      const task = await read(taskId, signal)
      if (!task) throw new TaskNotFoundError(taskId)
      return task
    },
    update: async (taskId, patch, expectedVersion, signal) => {
      throwIfAborted(signal)
      const result = await client.update(taskId, patch, expectedVersion, {
        signal,
      })
      throwIfAborted(signal)
      return result.task
    },
    renewLease: async (leaseId, options, signal) => {
      throwIfAborted(signal)
      const result = await client.renewLease(leaseId, options ?? {}, {
        signal,
      })
      throwIfAborted(signal)
      return result.lease
    },
    releaseLease: async (leaseId, options, signal) => {
      throwIfAborted(signal)
      const result = await client.releaseLease(leaseId, options ?? {}, {
        signal,
      })
      throwIfAborted(signal)
      return result.lease
    },
    recover: async (now, signal) => {
      throwIfAborted(signal)
      const result = await client.recover(now, { signal })
      throwIfAborted(signal)
      return result
    },
    close: async () => {},
  }
}

function localBackend(graph: TaskGraph, closeGraph: boolean): Backend {
  const run = async <T>(
    operation: () => T,
    signal?: AbortSignal,
  ): Promise<T> => {
    throwIfAborted(signal)
    const result = operation()
    throwIfAborted(signal)
    return result
  }

  return {
    route: (task, mode, signal) =>
      run(() => graph.route(task, mode === undefined ? {} : { mode }), signal),
    read: (taskId, signal) => run(() => graph.read(taskId), signal),
    list: signal => run(() => graph.list(), signal),
    claimTask: (taskId, owner, options, signal) =>
      run(() => graph.claimTask(taskId, owner, options), signal),
    requireTask: (taskId, signal) =>
      run(() => graph.requireTask(taskId), signal),
    update: (taskId, patch, expectedVersion, signal) =>
      run(() => graph.update(taskId, patch, expectedVersion), signal),
    renewLease: (leaseId, options, signal) =>
      run(() => graph.renewLease(leaseId, options), signal),
    releaseLease: (leaseId, options, signal) =>
      run(() => graph.releaseLease(leaseId, options), signal),
    recover: (now, signal) => run(() => graph.recover(now), signal),
    close: async () => {
      if (closeGraph) graph.close()
    },
  }
}

class WorkerTaskGraphAdapter implements WorkerTaskGraph {
  private authority: Authority = 'unselected'
  private readonly daemon: Backend
  private readonly localFactory: () => TaskGraph
  private local?: Backend
  private firstOperation?: Promise<void>
  private closed = false

  constructor(options: WorkerTaskGraphOptions = {}) {
    this.daemon = daemonBackend(options.daemon ?? new TaskGraphDaemonClient())
    this.localFactory = options.localFactory ?? (() => openTaskGraph())
  }

  private async dispatch<T>(
    operation: (backend: Backend) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal)
    if (this.closed) throw new Error('Worker task graph is closed')

    if (this.authority === 'local') {
      return operation(this.localBackend())
    }
    if (this.authority === 'daemon') {
      return operation(this.daemon)
    }

    // The first operation selects the authority. Other concurrent callers
    // wait for that operation instead of probing the daemon independently.
    if (this.firstOperation) {
      await this.firstOperation
      return this.dispatch(operation, signal)
    }

    const first = this.dispatchFirst(operation, signal)
    this.firstOperation = first.then(
      () => undefined,
      () => undefined,
    )
    return first
  }

  private async dispatchFirst<T>(
    operation: (backend: Backend) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      const result = await operation(this.daemon)
      this.authority = 'daemon'
      return result
    } catch (error) {
      if (signal?.aborted) {
        this.authority = 'daemon'
        throw new AbortError()
      }
      if (!isPreDispatchTaskGraphUnavailable(error)) {
        // Lock the lifecycle to the daemon after an ambiguous or semantic
        // failure. Cleanup must never silently switch authorities.
        this.authority = 'daemon'
        throw error
      }
      this.authority = 'local'
      return operation(this.localBackend())
    }
  }

  private localBackend(): Backend {
    if (!this.local) {
      this.local = localBackend(this.localFactory(), true)
    }
    return this.local
  }

  route(task: RouteTaskInput, mode?: 'block' | 'reject', signal?: AbortSignal) {
    return this.dispatch(backend => backend.route(task, mode, signal), signal)
  }

  read(taskId: string, signal?: AbortSignal) {
    return this.dispatch(backend => backend.read(taskId, signal), signal)
  }

  list(signal?: AbortSignal) {
    return this.dispatch(backend => backend.list(signal), signal)
  }

  claimTask(
    taskId: string,
    owner: string,
    options?: ClaimOptions,
    signal?: AbortSignal,
  ) {
    return this.dispatch(
      backend => backend.claimTask(taskId, owner, options, signal),
      signal,
    )
  }

  requireTask(taskId: string, signal?: AbortSignal) {
    return this.dispatch(backend => backend.requireTask(taskId, signal), signal)
  }

  update(
    taskId: string,
    patch: TaskUpdate,
    expectedVersion?: number,
    signal?: AbortSignal,
  ) {
    return this.dispatch(
      backend => backend.update(taskId, patch, expectedVersion, signal),
      signal,
    )
  }

  renewLease(leaseId: string, options = {}, signal?: AbortSignal) {
    return this.dispatch(
      backend => backend.renewLease(leaseId, options, signal),
      signal,
    )
  }

  releaseLease(leaseId: string, options = {}, signal?: AbortSignal) {
    return this.dispatch(
      backend => backend.releaseLease(leaseId, options, signal),
      signal,
    )
  }

  recover(now?: string | Date, signal?: AbortSignal) {
    return this.dispatch(backend => backend.recover(now, signal), signal)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.firstOperation
    await this.local?.close()
  }
}

export function createWorkerTaskGraph(
  options: WorkerTaskGraphOptions = {},
): WorkerTaskGraph {
  return new WorkerTaskGraphAdapter(options)
}

/** Explicit async test seam for a direct in-memory/SQLite TaskGraph. */
export function createTestWorkerTaskGraph(graph: TaskGraph): WorkerTaskGraph {
  return localBackend(graph, false)
}
