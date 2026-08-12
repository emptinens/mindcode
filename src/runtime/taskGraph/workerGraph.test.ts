import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TaskGraph } from '../../tasks/graph/taskGraph.js'
import type {
  ClaimOptions,
  ClaimResult,
  RouteResult,
  RouteTaskInput,
  TaskLease,
  TaskRecord,
  TaskUpdate,
} from '../../tasks/graph/types.js'
import {
  DaemonDisabledError,
  DaemonDisconnectedError,
  DaemonTimeoutError,
} from '../daemon/errors.js'
import {
  type WorkerTaskGraphDaemon,
  createTestWorkerTaskGraph,
  createWorkerTaskGraph,
} from './workerGraph.js'

const directories: string[] = []
const graphs: TaskGraph[] = []

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close()
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function graph(): TaskGraph {
  const directory = mkdtempSync('/tmp/mindcode-worker-graph-')
  directories.push(directory)
  const value = new TaskGraph({ databasePath: join(directory, 'tasks.db') })
  graphs.push(value)
  return value
}

type Calls = {
  route: number
  read: number
  list: number
  claim: number
  update: number
  renew: number
  release: number
  recover: number
}

function calls(): Calls {
  return {
    route: 0,
    read: 0,
    list: 0,
    claim: 0,
    update: 0,
    renew: 0,
    release: 0,
    recover: 0,
  }
}

function daemonFor(
  backingGraph: TaskGraph,
  counts: Calls,
  failures: Partial<Record<keyof Calls, unknown>> = {},
): WorkerTaskGraphDaemon {
  const backing = createTestWorkerTaskGraph(backingGraph)
  const fail = (name: keyof Calls): void => {
    const error = failures[name]
    if (error !== undefined) throw error
  }
  return {
    route: async (task: RouteTaskInput, mode?: 'block' | 'reject') => {
      counts.route += 1
      fail('route')
      return backing.route(task, mode)
    },
    read: async (taskId: string) => {
      counts.read += 1
      fail('read')
      return { task: await backing.read(taskId) }
    },
    list: async () => {
      counts.list += 1
      fail('list')
      return { tasks: await backing.list() }
    },
    claim: async (
      request: { task_id: string; owner: string } & ClaimOptions,
    ) => {
      counts.claim += 1
      fail('claim')
      return backing.claimTask(request.task_id, request.owner, request)
    },
    update: async (
      taskId: string,
      patch: TaskUpdate,
      expectedVersion?: number,
    ) => {
      counts.update += 1
      fail('update')
      return { task: await backing.update(taskId, patch, expectedVersion) }
    },
    renewLease: async (
      leaseId: string,
      options?: { owner?: string; ttl_ms?: number; now?: string | Date },
    ) => {
      counts.renew += 1
      fail('renew')
      return { lease: await backing.renewLease(leaseId, options) }
    },
    releaseLease: async (
      leaseId: string,
      options?: { owner?: string; now?: string | Date },
    ) => {
      counts.release += 1
      fail('release')
      return { lease: await backing.releaseLease(leaseId, options) }
    },
    recover: async (now?: string | Date) => {
      counts.recover += 1
      fail('recover')
      return backing.recover(now)
    },
  } as unknown as WorkerTaskGraphDaemon
}

describe('worker task graph authority adapter', () => {
  test('uses daemon RPC for the complete lifecycle after daemon success', async () => {
    const daemonGraph = graph()
    const localGraph = graph()
    const daemonCalls = calls()
    let localFactoryCalls = 0
    const adapter = createWorkerTaskGraph({
      daemon: daemonFor(daemonGraph, daemonCalls),
      localFactory: () => {
        localFactoryCalls += 1
        return localGraph
      },
    })

    const routed = await adapter.route({ id: 'daemon-task' })
    expect(routed.task?.status).toBe('pending')
    const claim = await adapter.claimTask('daemon-task', 'worker', {
      ttl_ms: 1_000,
    })
    expect(claim.ok).toBe(true)
    if (!claim.ok) throw new Error('expected daemon claim')
    await adapter.update(
      'daemon-task',
      { status: 'running' },
      claim.task.version,
    )
    expect((await adapter.read('daemon-task'))?.status).toBe('running')
    await adapter.releaseLease(claim.lease.lease_id, { owner: 'worker' })
    await adapter.close()

    expect(daemonCalls).toMatchObject({
      route: 1,
      claim: 1,
      update: 1,
      read: 1,
      release: 1,
    })
    expect(localFactoryCalls).toBe(0)
    expect(localGraph.snapshot().tasks).toHaveLength(0)
  })

  test('recovers through the selected daemon authority', async () => {
    const daemonGraph = graph()
    const localGraph = graph()
    const daemonCalls = calls()
    const adapter = createWorkerTaskGraph({
      daemon: daemonFor(daemonGraph, daemonCalls),
      localFactory: () => localGraph,
    })

    await adapter.route({ id: 'recover-task' })
    const claim = await adapter.claimTask('recover-task', 'worker', {
      ttl_ms: 1,
      now: '2026-08-11T00:00:00.000Z',
    })
    expect(claim.ok).toBe(true)
    const recovered = await adapter.recover('2026-08-11T00:00:01.000Z')
    expect(recovered.recovered_tasks.map(task => task.id)).toEqual(['recover-task'])
    expect(daemonCalls.recover).toBe(1)
    expect(localGraph.snapshot().tasks).toHaveLength(0)
    await adapter.close()
  })

  test('selects local authority once after disabled daemon and never calls daemon again', async () => {
    const daemonGraph = graph()
    const localGraph = graph()
    const daemonCalls = calls()
    let localFactoryCalls = 0
    const adapter = createWorkerTaskGraph({
      daemon: daemonFor(daemonGraph, daemonCalls, {
        route: new DaemonDisabledError(),
      }),
      localFactory: () => {
        localFactoryCalls += 1
        return localGraph
      },
    })

    await adapter.route({ id: 'local-task' })
    expect((await adapter.read('local-task'))?.id).toBe('local-task')
    await adapter.close()

    expect(daemonCalls.route).toBe(1)
    expect(daemonCalls.read).toBe(0)
    expect(localFactoryCalls).toBe(1)
    expect(daemonGraph.snapshot().tasks).toHaveLength(0)
  })

  test.each([
    ['disconnect', new DaemonDisconnectedError()],
    ['request timeout', new DaemonTimeoutError('request', 10)],
  ])(
    'fails closed on ambiguous daemon %s and does not open local SQLite',
    async (_label, error) => {
      const daemonGraph = graph()
      const daemonCalls = calls()
      let localFactoryCalls = 0
      const adapter = createWorkerTaskGraph({
        daemon: daemonFor(daemonGraph, daemonCalls, {
          route: error,
          read: error,
        }),
        localFactory: () => {
          localFactoryCalls += 1
          return graph()
        },
      })

      await expect(adapter.route({ id: 'ambiguous-task' })).rejects.toBe(error)
      await expect(adapter.read('ambiguous-task')).rejects.toBe(error)
      await adapter.close()

      expect(daemonCalls.route).toBe(1)
      expect(daemonCalls.read).toBe(1)
      expect(localFactoryCalls).toBe(0)
    },
  )

  test('does not fallback when cancellation races the initial daemon operation', async () => {
    const daemonGraph = graph()
    const daemonCalls = calls()
    let localFactoryCalls = 0
    const controller = new AbortController()
    const adapter = createWorkerTaskGraph({
      daemon: daemonFor(daemonGraph, daemonCalls, {
        route: new DaemonDisabledError(),
      }),
      localFactory: () => {
        localFactoryCalls += 1
        return graph()
      },
    })
    controller.abort()

    await expect(
      adapter.route({ id: 'cancelled-task' }, undefined, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(localFactoryCalls).toBe(0)
    await adapter.close()
  })
})
