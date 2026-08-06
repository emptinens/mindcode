import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createTestWorkerTaskGraph } from '../../runtime/taskGraph/workerGraph.js'
import { TaskGraph } from '../../tasks/graph/taskGraph.js'
import { AdaptiveSwarmConcurrencyPolicy } from '../../utils/swarm/concurrencyPolicy.js'
import type { WorkerEffort } from '../../utils/swarm/backends/types.js'
import {
  acquireWorkerExecution,
  WorkerLifecycleTimeoutError,
  type WorkerExecutionPhase,
} from './workerLifecycle.js'

const tempDirs: string[] = []
const graphs: TaskGraph[] = []

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function graph(options: { clock?: () => Date } = {}): TaskGraph {
  const directory = mkdtempSync('/tmp/mindcode-worker-lifecycle-')
  tempDirs.push(directory)
  const taskGraph = new TaskGraph({
    databasePath: join(directory, 'tasks.db'),
    ...options,
  })
  graphs.push(taskGraph)
  return taskGraph
}

describe('Agent worker lifecycle', () => {
  test('routes, atomically claims, acquires weighted capacity, and completes', async () => {
    const taskGraph = graph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy(8)
    const execution = await acquireWorkerExecution(
      {
        taskId: 'task-a',
        owner: 'agent-a',
        schedulerScope: 'session-a',
        effort: 'high',
        writeSet: ['src/a.ts'],
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )

    expect(taskGraph.requireTask('task-a')).toMatchObject({
      status: 'running',
      owner: 'agent-a',
      write_set: ['src/a.ts'],
    })
    expect(scheduler.snapshot()).toMatchObject({
      activeWorkers: 1,
      activeWeight: 4,
    })

    await execution.complete()
    expect(taskGraph.requireTask('task-a')).toMatchObject({
      status: 'completed',
      lease_id: null,
    })
    expect(scheduler.snapshot().activeWeight).toBe(0)
    await execution.complete()
  })

  test('serializes overlapping workers until the dependency completes', async () => {
    const taskGraph = graph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy(8)
    const dependencies = {
      graph: createTestWorkerTaskGraph(taskGraph),
      dependencyPollMs: 5,
      acquireSchedulerLease: (
        scope: string,
        effort: WorkerEffort,
        signal?: AbortSignal,
      ) =>
        scheduler.acquire(scope, { effort, signal }),
    }
    const first = await acquireWorkerExecution(
      {
        taskId: 'first',
        owner: 'agent-first',
        schedulerScope: 'session',
        effort: 'high',
        writeSet: ['src/shared.ts'],
      },
      dependencies,
    )
    const secondPromise = acquireWorkerExecution(
      {
        taskId: 'second',
        owner: 'agent-second',
        schedulerScope: 'session',
        effort: 'high',
        readSet: ['src/shared.ts'],
      },
      dependencies,
    )

    await Bun.sleep(20)
    expect(taskGraph.requireTask('second')).toMatchObject({
      status: 'pending',
      blocked_by: ['first'],
    })
    await first.complete()

    const second = await secondPromise
    expect(taskGraph.requireTask('second').status).toBe('running')
    await second.complete()
    expect(taskGraph.requireTask('second').status).toBe('completed')
  })

  test('aborting dependency wait leaves a reusable pending task', async () => {
    const taskGraph = graph()
    taskGraph.route({ id: 'dependency', write_set: ['src/a.ts'] })
    const controller = new AbortController()
    const pending = acquireWorkerExecution(
      {
        taskId: 'blocked',
        owner: 'agent-blocked',
        schedulerScope: 'session',
        effort: 'medium',
        readSet: ['src/a.ts'],
        signal: controller.signal,
      },
      { graph: createTestWorkerTaskGraph(taskGraph), dependencyPollMs: 5 },
    )
    await Bun.sleep(15)
    controller.abort()

    await expect(pending).rejects.toThrow()
    expect(taskGraph.requireTask('blocked')).toMatchObject({
      status: 'pending',
      owner: null,
      lease_id: null,
    })
  })

  test('release returns an unfinished task to pending and frees capacity', async () => {
    const taskGraph = graph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy(2)
    const execution = await acquireWorkerExecution(
      {
        taskId: 'released',
        owner: 'agent',
        schedulerScope: 'session',
        effort: 'medium',
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )

    await execution.release()
    expect(taskGraph.requireTask('released')).toMatchObject({
      status: 'pending',
      owner: null,
      lease_id: null,
    })
    expect(scheduler.snapshot().activeWeight).toBe(0)
  })

  test('runtime scopes isolate reused public IDs without hiding global targets', async () => {
    const taskGraph = graph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy(4)
    const dependencies = {
      graph: createTestWorkerTaskGraph(taskGraph),
      acquireSchedulerLease: (
        scope: string,
        effort: WorkerEffort,
        signal?: AbortSignal,
      ) => scheduler.acquire(scope, { effort, signal }),
    }
    const orphan = await acquireWorkerExecution(
      {
        taskId: 'same-public-id',
        owner: 'old-worker',
        schedulerScope: 'old-runtime',
        runtimeScope: 'runtime-before-restart',
        effort: 'medium',
      },
      dependencies,
    )

    const fresh = await acquireWorkerExecution(
      {
        taskId: 'same-public-id',
        owner: 'new-worker',
        schedulerScope: 'new-runtime',
        runtimeScope: 'runtime-after-restart',
        effort: 'medium',
      },
      dependencies,
    )

    expect(await fresh.getTask()).toMatchObject({
      id: 'same-public-id',
      status: 'running',
    })
    expect(scheduler.snapshot()).toMatchObject({
      activeWorkers: 2,
      activeWeight: 4,
    })
    await fresh.complete()
    await orphan.release()
  })

  test('duplicate task IDs cannot fail the active owner lifecycle', async () => {
    const taskGraph = graph()
    const first = await acquireWorkerExecution(
      {
        taskId: 'duplicate-id',
        owner: 'first-owner',
        schedulerScope: 'session',
        runtimeScope: 'same-runtime',
        effort: 'low',
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )

    await expect(
      acquireWorkerExecution(
        {
          taskId: 'duplicate-id',
          owner: 'second-owner',
          schedulerScope: 'session',
          runtimeScope: 'same-runtime',
          effort: 'low',
        },
        { graph: createTestWorkerTaskGraph(taskGraph) },
      ),
    ).rejects.toThrow('cannot be claimed: status_not_pending')
    expect(await first.getTask()).toMatchObject({
      status: 'running',
      owner: 'first-owner',
    })
    await first.complete()
    expect(await first.getTask()).toMatchObject({ status: 'completed' })
  })

  test('preserves overlap serialization across runtime namespaces', async () => {
    const taskGraph = graph()
    const first = await acquireWorkerExecution(
      {
        taskId: 'first-runtime-task',
        owner: 'first-worker',
        schedulerScope: 'first-runtime',
        runtimeScope: 'runtime-a',
        targetScope: '/repo/shared',
        effort: 'low',
        writeSet: ['src/shared.ts'],
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )
    const phases: WorkerExecutionPhase[] = []
    const secondPromise = acquireWorkerExecution(
      {
        taskId: 'second-runtime-task',
        owner: 'second-worker',
        schedulerScope: 'second-runtime',
        runtimeScope: 'runtime-b',
        targetScope: '/repo/shared',
        effort: 'low',
        readSet: ['src/shared.ts'],
        onPhase: phase => phases.push(phase),
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        dependencyPollMs: 2,
        dependencyWaitTimeoutMs: 200,
      },
    )

    await Bun.sleep(15)
    expect(phases).toContain('waiting_dependency')
    await first.complete()
    const second = await secondPromise
    expect(second.routeDecision).toMatchObject({
      action: 'blocked',
      blocked_by: ['first-runtime-task'],
    })
    expect(await second.getTask()).toMatchObject({
      status: 'running',
      read_set: ['src/shared.ts'],
    })
    await second.complete()
  })

  test('does not report equal relative paths in different projects as overlap', async () => {
    const taskGraph = graph()
    const first = await acquireWorkerExecution(
      {
        taskId: 'project-a-task',
        owner: 'project-a-worker',
        schedulerScope: 'project-a',
        runtimeScope: 'runtime-a',
        targetScope: '/repo/a',
        effort: 'low',
        writeSet: ['src/shared.ts'],
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )
    const second = await acquireWorkerExecution(
      {
        taskId: 'project-b-task',
        owner: 'project-b-worker',
        schedulerScope: 'project-b',
        runtimeScope: 'runtime-b',
        targetScope: '/repo/b',
        effort: 'low',
        writeSet: ['src/shared.ts'],
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )

    expect(second.routeDecision.conflicts).toEqual([])
    expect((await second.getTask())?.write_set).toEqual(['src/shared.ts'])
    await second.complete()
    await first.complete()
  })

  test('accepts completed shared task dependencies without storing foreign IDs', async () => {
    const taskGraph = graph()
    const execution = await acquireWorkerExecution(
      {
        taskId: 'worker-for-shared-task',
        owner: 'worker',
        schedulerScope: 'session',
        runtimeScope: 'runtime',
        effort: 'low',
        blockedBy: ['1'],
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        resolveExternalDependency: async id =>
          id === '1' ? 'completed' : 'missing',
      },
    )

    expect(await execution.getTask()).toMatchObject({
      status: 'running',
      blocked_by: [],
    })
    await execution.complete()
  })

  test('rejects missing shared dependencies and waits for incomplete ones', async () => {
    const taskGraph = graph()
    const input = {
      taskId: 'blocked-worker',
      owner: 'worker',
      schedulerScope: 'session',
      runtimeScope: 'runtime',
      effort: 'medium' as const,
      blockedBy: ['1'],
    }

    await expect(
      acquireWorkerExecution(input, {
        graph: createTestWorkerTaskGraph(taskGraph),
        resolveExternalDependency: async () => 'missing',
      }),
    ).rejects.toThrow('references missing dependency 1')
    let checks = 0
    const phases: WorkerExecutionPhase[] = []
    const execution = await acquireWorkerExecution(
      { ...input, onPhase: phase => phases.push(phase) },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        dependencyPollMs: 2,
        // This case verifies polling semantics, not the timeout boundary.
        // Keep enough headroom when the full suite, typecheck, and builds run
        // concurrently on a loaded CI machine.
        dependencyWaitTimeoutMs: 1_000,
        resolveExternalDependency: async () =>
          ++checks >= 3 ? 'completed' : 'incomplete',
      },
    )
    expect(checks).toBe(3)
    expect(phases).toContain('waiting_dependency')
    expect(await execution.getTask()).toMatchObject({
      status: 'running',
      blocked_by: [],
    })
    await execution.complete()
  })

  test('bounds waits for incomplete shared dependencies', async () => {
    const taskGraph = graph()
    await expect(
      acquireWorkerExecution(
        {
          taskId: 'external-timeout',
          owner: 'worker',
          schedulerScope: 'session',
          runtimeScope: 'runtime',
          effort: 'medium',
          blockedBy: ['shared-pending'],
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          dependencyPollMs: 2,
          dependencyWaitTimeoutMs: 10,
          resolveExternalDependency: async () => 'incomplete',
        },
      ),
    ).rejects.toMatchObject({ phase: 'dependency' })
    expect(taskGraph.snapshot().tasks).toHaveLength(0)
  })

  test('bounds a stalled external dependency lookup itself', async () => {
    const taskGraph = graph()
    await expect(
      acquireWorkerExecution(
        {
          taskId: 'external-stall',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'medium',
          blockedBy: ['stalled-shared-task'],
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          dependencyWaitTimeoutMs: 10,
          resolveExternalDependency: () => new Promise(() => {}),
        },
      ),
    ).rejects.toMatchObject({ phase: 'dependency' })
    expect(taskGraph.snapshot().tasks).toHaveLength(0)
  })

  test('rejects a terminal failed lifecycle dependency without polling', async () => {
    const taskGraph = graph()
    taskGraph.route({ id: 'failed-dependency' })
    const failed = taskGraph.requireTask('failed-dependency')
    taskGraph.update(
      failed.id,
      { status: 'failed' },
      failed.version,
    )

    await expect(
      acquireWorkerExecution(
        {
          taskId: 'never-started',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'medium',
          blockedBy: ['failed-dependency'],
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          dependencyWaitTimeoutMs: 10_000,
        },
      ),
    ).rejects.toThrow('depends on failed task failed-dependency')
    expect(taskGraph.read('never-started')).toBeNull()
  })

  test('bounds dependency waits, marks the waiter failed, and exposes phases', async () => {
    const taskGraph = graph()
    const phases: WorkerExecutionPhase[] = []
    taskGraph.route({ id: 'dependency', write_set: ['src/a.ts'] })
    const dependency = taskGraph.claimTask('dependency', 'dependency-worker')
    expect(dependency.ok).toBe(true)

    await expect(
      acquireWorkerExecution(
        {
          taskId: 'timed-waiter',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'medium',
          blockedBy: ['dependency'],
          onPhase: phase => phases.push(phase),
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          dependencyPollMs: 2,
          dependencyWaitTimeoutMs: 10,
        },
      ),
    ).rejects.toBeInstanceOf(WorkerLifecycleTimeoutError)

    expect(taskGraph.requireTask('timed-waiter')).toMatchObject({
      status: 'failed',
      lease_id: null,
    })
    expect(phases).toContain('waiting_dependency')
  })

  test('bounds scheduler acquisition and releases a late lease', async () => {
    const taskGraph = graph()
    let resolveLateLease: ((lease: {
      leaseId: string
      teamName: string
      effort: WorkerEffort
      weight: number
      release: () => boolean
    }) => void) | undefined
    let releaseCount = 0
    const lateLease = new Promise<{
      leaseId: string
      teamName: string
      effort: WorkerEffort
      weight: number
      release: () => boolean
    }>(resolve => {
      resolveLateLease = resolve
    })

    await expect(
      acquireWorkerExecution(
        {
          taskId: 'scheduler-timeout',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'medium',
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          schedulerWaitTimeoutMs: 10,
          acquireSchedulerLease: async () => lateLease,
        },
      ),
    ).rejects.toMatchObject({ phase: 'scheduler' })

    expect(taskGraph.requireTask('scheduler-timeout')).toMatchObject({
      status: 'failed',
      lease_id: null,
    })
    resolveLateLease?.({
      leaseId: 'late',
      teamName: 'session',
      effort: 'medium',
      weight: 2,
      release: () => {
        releaseCount += 1
        return true
      },
    })
    await Bun.sleep(1)
    expect(releaseCount).toBe(1)
  })

  test('cleans scheduler timeout state after a synchronous acquire failure', async () => {
    const taskGraph = graph()
    await expect(
      acquireWorkerExecution(
        {
          taskId: 'scheduler-sync-failure',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'low',
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          schedulerWaitTimeoutMs: 10,
          acquireSchedulerLease: () => {
            throw new Error('synchronous scheduler failure')
          },
        },
      ),
    ).rejects.toThrow('synchronous scheduler failure')
    await Bun.sleep(20)
    expect(taskGraph.snapshot().tasks).toHaveLength(1)
  })

  test('preserves the scheduler timeout when aborting the queued acquire', async () => {
    const taskGraph = graph()
    await expect(
      acquireWorkerExecution(
        {
          taskId: 'scheduler-abort-race',
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'medium',
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          schedulerWaitTimeoutMs: 10,
          acquireSchedulerLease: (_scope, _effort, signal) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('scheduler aborted internally')),
                { once: true },
              )
            }),
        },
      ),
    ).rejects.toMatchObject({
      name: 'WorkerLifecycleTimeoutError',
      phase: 'scheduler',
    })
  })

  test('renews the active lease before TTL expiry', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z')
    const taskGraph = graph({ clock: () => now })
    let heartbeat: (() => void) | undefined
    let stopped = 0
    const execution = await acquireWorkerExecution(
      {
        taskId: 'heartbeat-renewal',
        owner: 'worker',
        schedulerScope: 'session',
        effort: 'low',
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        taskLeaseTtlMs: 100,
        taskLeaseHeartbeat: (callback, intervalMs) => {
          expect(intervalMs).toBe(33)
          heartbeat = callback
          return () => {
            stopped += 1
          }
        },
      },
    )

    const initialLease = taskGraph.getTaskLease('heartbeat-renewal')
    expect(initialLease).not.toBeNull()
    now = new Date(Date.parse(initialLease?.expires_at ?? '') - 1)
    await heartbeat?.()

    const renewedLease = taskGraph.getTaskLease('heartbeat-renewal')
    expect(renewedLease?.expires_at).toBe(
      new Date(now.getTime() + 100).toISOString(),
    )
    now = new Date(Date.parse(initialLease?.expires_at ?? '') + 1)
    expect(taskGraph.expireLeases().expired_leases).toHaveLength(0)
    expect(taskGraph.requireTask('heartbeat-renewal').status).toBe('running')

    await execution.complete()
    expect(stopped).toBe(1)
  })

  test('stops the lease heartbeat only when execution settles', async () => {
    for (const action of ['complete', 'fail', 'release'] as const) {
      let stopped = 0
      const taskGraph = graph()
      const execution = await acquireWorkerExecution(
        {
          taskId: `heartbeat-${action}`,
          owner: 'worker',
          schedulerScope: 'session',
          effort: 'low',
        },
        {
          graph: createTestWorkerTaskGraph(taskGraph),
          taskLeaseTtlMs: 100,
          taskLeaseHeartbeat: () => () => {
            stopped += 1
          },
        },
      )

      execution[action]()
      expect(stopped).toBe(1)
    }

    let stopped = 0
    const controller = new AbortController()
    const taskGraph = graph()
    const execution = await acquireWorkerExecution(
      {
        taskId: 'heartbeat-abort',
        owner: 'worker',
        schedulerScope: 'session',
        effort: 'low',
        signal: controller.signal,
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        taskLeaseTtlMs: 100,
        taskLeaseHeartbeat: () => () => {
          stopped += 1
        },
      },
    )

    controller.abort()
    // The admission signal belongs to the Leader turn. Background workers
    // deliberately survive that turn being interrupted, so their lease must
    // keep renewing until the worker lifecycle is explicitly settled.
    expect(stopped).toBe(0)
    expect(taskGraph.requireTask('heartbeat-abort').status).toBe('running')
    await execution.release()
    expect(stopped).toBe(1)
  })

  test('retries lease renewal after a transient heartbeat failure', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z')
    const taskGraph = graph({ clock: () => now })
    let heartbeat: (() => void) | undefined
    const renewLease = taskGraph.renewLease.bind(taskGraph)
    let attempts = 0
    taskGraph.renewLease = ((...args: Parameters<typeof renewLease>) => {
      attempts += 1
      if (attempts === 1) throw new Error('database is temporarily busy')
      return renewLease(...args)
    }) as typeof taskGraph.renewLease

    const execution = await acquireWorkerExecution(
      {
        taskId: 'heartbeat-retry',
        owner: 'worker',
        schedulerScope: 'session',
        effort: 'low',
      },
      {
        graph: createTestWorkerTaskGraph(taskGraph),
        taskLeaseTtlMs: 300,
        taskLeaseHeartbeat: callback => {
          heartbeat = callback
          return () => {}
        },
      },
    )
    const initial = taskGraph.getTaskLease('heartbeat-retry')
    expect(initial).not.toBeNull()

    now = new Date(Date.parse(initial?.acquired_at ?? '') + 100)
    await heartbeat?.()
    now = new Date(Date.parse(initial?.acquired_at ?? '') + 200)
    await heartbeat?.()

    expect(attempts).toBe(2)
    expect(taskGraph.getTaskLease('heartbeat-retry')?.expires_at).toBe(
      new Date(now.getTime() + 300).toISOString(),
    )
    await execution.complete()
  })

  test('persists validated report identity and policy epoch on terminal completion', async () => {
    const taskGraph = graph()
    const policyDigest = 'a'.repeat(64)
    const reportId = 'b'.repeat(64)
    const execution = await acquireWorkerExecution(
      {
        taskId: 'report-backed-completion',
        owner: 'worker-report',
        schedulerScope: 'session',
        effort: 'medium',
        policyEpoch: 12,
        policyDigest,
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )

    expect(taskGraph.requireTask('report-backed-completion')).toMatchObject({
      status: 'running',
      policy_epoch: 12,
      report_id: null,
    })
    await execution.complete({
      reportId,
      policyEpoch: 12,
      policyDigest,
    })

    expect(taskGraph.requireTask('report-backed-completion')).toMatchObject({
      status: 'completed',
      policy_epoch: 12,
      report_id: reportId,
    })
  })

  test('rejects stale report policy epochs before terminalizing the task', async () => {
    const taskGraph = graph()
    const policyDigest = 'c'.repeat(64)
    const reportId = 'd'.repeat(64)
    const execution = await acquireWorkerExecution(
      {
        taskId: 'stale-report',
        owner: 'worker-stale',
        schedulerScope: 'session',
        effort: 'low',
        policyEpoch: 21,
        policyDigest,
      },
      { graph: createTestWorkerTaskGraph(taskGraph) },
    )

    expect(() =>
      execution.complete({
        reportId,
        policyEpoch: 20,
        policyDigest,
      }),
    ).toThrow('stale or mismatched worker report policy epoch')
    expect(taskGraph.requireTask('stale-report')).toMatchObject({
      status: 'running',
      policy_epoch: 21,
      report_id: null,
    })

    await execution.fail({
      reportId,
      policyEpoch: 21,
      policyDigest,
    })
    expect(taskGraph.requireTask('stale-report')).toMatchObject({
      status: 'failed',
      policy_epoch: 21,
      report_id: reportId,
    })
  })

  test('renews only the active owner lease and handles expired and released leases', async () => {
    let now = new Date('2026-08-05T00:00:00.000Z')
    const taskGraph = graph({ clock: () => now })
    const execution = await acquireWorkerExecution(
      {
        taskId: 'renewal-semantics',
        owner: 'owner-a',
        schedulerScope: 'session',
        effort: 'low',
      },
      { graph: createTestWorkerTaskGraph(taskGraph), taskLeaseTtlMs: 100 },
    )
    const lease = taskGraph.getTaskLease('renewal-semantics')
    expect(lease).not.toBeNull()

    expect(() =>
      taskGraph.renewLease(lease?.lease_id ?? '', { owner: 'owner-b' }),
    ).toThrow()
    expect(taskGraph.getTaskLease('renewal-semantics')?.expires_at).toBe(
      lease?.expires_at,
    )

    now = new Date(Date.parse(lease?.expires_at ?? '') + 1)
    const expired = taskGraph.renewLease(lease?.lease_id ?? '', {
      owner: 'owner-a',
    })
    expect(expired?.released_at).not.toBeNull()
    expect(taskGraph.requireTask('renewal-semantics')).toMatchObject({
      status: 'pending',
      lease_id: null,
    })
    await execution.release()

    const releasedExecution = await acquireWorkerExecution(
      {
        taskId: 'released-renewal',
        owner: 'owner-a',
        schedulerScope: 'session',
        effort: 'low',
      },
      { graph: createTestWorkerTaskGraph(taskGraph), taskLeaseTtlMs: 100 },
    )
    const releasedLease = taskGraph.getTaskLease('released-renewal')
    await releasedExecution.release()
    const released = taskGraph.renewLease(releasedLease?.lease_id ?? '', {
      owner: 'owner-a',
    })
    expect(released?.released_at).not.toBeNull()
  })
})
