import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { TaskGraph } from '../../tasks/graph/taskGraph.js'
import { AdaptiveSwarmConcurrencyPolicy } from '../../utils/swarm/concurrencyPolicy.js'
import type { WorkerEffort } from '../../utils/swarm/backends/types.js'
import { acquireWorkerExecution } from './workerLifecycle.js'

const tempDirs: string[] = []
const graphs: TaskGraph[] = []

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close()
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function graph(): TaskGraph {
  const directory = mkdtempSync('/tmp/mindcode-worker-lifecycle-')
  tempDirs.push(directory)
  const taskGraph = new TaskGraph({ databasePath: join(directory, 'tasks.db') })
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
        graph: taskGraph,
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

    execution.complete()
    expect(taskGraph.requireTask('task-a')).toMatchObject({
      status: 'completed',
      lease_id: null,
    })
    expect(scheduler.snapshot().activeWeight).toBe(0)
    execution.complete()
  })

  test('serializes overlapping workers until the dependency completes', async () => {
    const taskGraph = graph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy(8)
    const dependencies = {
      graph: taskGraph,
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
    first.complete()

    const second = await secondPromise
    expect(taskGraph.requireTask('second').status).toBe('running')
    second.complete()
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
      { graph: taskGraph, dependencyPollMs: 5 },
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
        graph: taskGraph,
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )

    execution.release()
    expect(taskGraph.requireTask('released')).toMatchObject({
      status: 'pending',
      owner: null,
      lease_id: null,
    })
    expect(scheduler.snapshot().activeWeight).toBe(0)
  })
})
