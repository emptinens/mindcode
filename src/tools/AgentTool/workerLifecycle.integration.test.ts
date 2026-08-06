import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createTestWorkerTaskGraph } from '../../runtime/taskGraph/workerGraph.js'
import { TaskGraph } from '../../tasks/graph/taskGraph.js'
import {
  buildWorkerReport as buildWorkerReportProduction,
  persistValidatedWorkerReport,
  serializeWorkerReport,
} from './workerReport.js'
import {
  acquireWorkerExecution as acquireWorkerExecutionProduction,
} from './workerLifecycle.js'
import {
  AdaptiveSwarmConcurrencyPolicy,
  SWARM_EFFORT_WEIGHTS,
} from '../../utils/swarm/concurrencyPolicy.js'
import type { WorkerEffort } from '../../utils/swarm/backends/types.js'

const acquireWorkerExecution = (
  input: Parameters<typeof acquireWorkerExecutionProduction>[0],
  dependencies: NonNullable<
    Parameters<typeof acquireWorkerExecutionProduction>[1]
  >,
) =>
  acquireWorkerExecutionProduction(input, {
    ...dependencies,
    testOnlyAllowMissingPolicyIdentity: true,
  })

const STABLE_POLICY_IDENTITY = {
  policyEpoch: 0,
  policyDigest: 'a'.repeat(64),
} as const

function buildWorkerReport(
  input: Parameters<typeof buildWorkerReportProduction>[0],
) {
  return buildWorkerReportProduction({
    ...input,
    policyEpoch: input.policyEpoch ?? STABLE_POLICY_IDENTITY.policyEpoch,
    policyDigest: input.policyDigest ?? STABLE_POLICY_IDENTITY.policyDigest,
  })
}

const temporaryDirectories: string[] = []
const openGraphs: TaskGraph[] = []

function createGraph(): TaskGraph {
  const directory = mkdtempSync('/tmp/mindcode-agenttool-integration-')
  temporaryDirectories.push(directory)
  const graph = new TaskGraph({ databasePath: join(directory, 'tasks.db') })
  openGraphs.push(graph)
  return graph
}

function validWorkerReport(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 'worker-report/1',
    task_id: 'worker-task',
    run_id: 'worker-run',
    worker_id: 'worker-id',
    model: 'gpt-5.6-luna',
    effort_used: 'medium',
    policy_epoch: 0,
    policy_digest: '0'.repeat(64),
    status: 'completed',
    summary: 'Synthetic lifecycle execution completed.',
    changed_files: [],
    evidence: [
      {
        id: 'lifecycle-test',
        type: 'test',
        command: 'bun test lifecycle',
        exit_code: 0,
      },
    ],
    tokens_used: 1,
    validation: { verdict: 'pass' },
    blockers: [],
    ...overrides,
  }
}

afterEach(() => {
  for (const graph of openGraphs.splice(0)) graph.close()
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('AgentTool lifecycle integration audit', () => {
  test('runs Decompose → Validate/Route → Claim → weighted Acquire → Execute → Report → Release', async () => {
    const graph = createGraph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy({ budget: 8 })
    const acquiredEfforts: WorkerEffort[] = []

    // Synthetic Decompose output: the Leader assigns effort per task rather
    // than allowing a worker to inherit the Leader effort.
    const decomposed = [
      { taskId: 'integration-first', effort: 'high' as const, writeSet: ['src/shared.ts'] },
      { taskId: 'integration-second', effort: 'none' as const, readSet: ['src/shared.ts'] },
    ]
    const firstTask = decomposed[0]
    const secondTask = decomposed[1]
    if (!firstTask || !secondTask) throw new Error('invalid test decomposition')

    const first = await acquireWorkerExecution(
      {
        taskId: firstTask.taskId,
        owner: 'worker-first',
        schedulerScope: 'integration',
        effort: firstTask.effort,
        writeSet: firstTask.writeSet,
      },
      {
        graph: createTestWorkerTaskGraph(graph),
        dependencyPollMs: 2,
        acquireSchedulerLease: (scope, effort, signal) => {
          acquiredEfforts.push(effort)
          return scheduler.acquire(scope, { effort, signal })
        },
      },
    )

    expect(first.routeDecision).toMatchObject({
      action: 'allow',
      allowed: true,
      blocked_by: [],
    })
    expect(graph.requireTask('integration-first')).toMatchObject({
      status: 'running',
      owner: 'worker-first',
      write_set: ['src/shared.ts'],
    })
    expect(scheduler.snapshot()).toMatchObject({
      activeWorkers: 1,
      activeWeight: SWARM_EFFORT_WEIGHTS.high,
    })

    // Validate/Route detects the write/read overlap and adds a dependency;
    // the second worker cannot claim until the first worker completes.
    const secondPromise = acquireWorkerExecution(
      {
        taskId: secondTask.taskId,
        owner: 'worker-second',
        schedulerScope: 'integration',
        effort: secondTask.effort,
        readSet: secondTask.readSet,
      },
      {
        graph: createTestWorkerTaskGraph(graph),
        dependencyPollMs: 2,
        acquireSchedulerLease: (scope, effort, signal) => {
          acquiredEfforts.push(effort)
          return scheduler.acquire(scope, { effort, signal })
        },
      },
    )

    await Bun.sleep(10)
    expect(graph.requireTask('integration-second')).toMatchObject({
      status: 'pending',
      blocked_by: ['integration-first'],
      owner: null,
    })
    expect(acquiredEfforts).toEqual(['high'])

    const firstReport = buildWorkerReport({
      taskId: first.taskId,
      status: 'completed',
      declaredChangedFiles: ['src/shared.ts'],
      finalText: JSON.stringify(
        validWorkerReport({
          changed_files: ['src/shared.ts'],
          effort_used: 'max',
          summary: 'Write completed and verified.',
        }),
      ),
      tokensUsed: 42,
      effortUsed: first.effort,
    })
    expect(firstReport).toMatchObject({
      schema_version: 'worker-report/1',
      task_id: 'integration-first',
      status: 'completed',
      changed_files: ['src/shared.ts'],
      tokens_used: 42,
      effort_used: 'high',
      model: 'gpt-5.6-luna',
      validation: { verdict: 'pass' },
    })
    await first.complete()

    const second = await secondPromise
    expect(acquiredEfforts).toEqual(['high', 'none'])
    expect(second.routeDecision).toMatchObject({
      action: 'blocked',
      allowed: true,
      blocked_by: ['integration-first'],
    })
    const secondReport = buildWorkerReport({
      taskId: second.taskId,
      status: 'completed',
      finalText: JSON.stringify(
        validWorkerReport({
          changed_files: [],
          summary: 'Read completed and verified.',
        }),
      ),
      tokensUsed: 7,
      effortUsed: second.effort,
    })
    expect(secondReport.effort_used).toBe('none')
    await second.complete()

    expect(graph.requireTask('integration-first')).toMatchObject({
      status: 'completed',
      lease_id: null,
    })
    expect(graph.requireTask('integration-second')).toMatchObject({
      status: 'completed',
      lease_id: null,
    })
    expect(scheduler.snapshot()).toMatchObject({
      activeWorkers: 0,
      activeWeight: 0,
      queuedRequests: 0,
    })
  })

  test('allows overlapping targets only with explicit worktree isolation', async () => {
    const graph = createGraph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy({ budget: 12 })

    const first = await acquireWorkerExecution(
      {
        taskId: 'shared-writer',
        owner: 'worker-shared',
        schedulerScope: 'integration-isolation',
        effort: 'high',
        writeSet: ['src/conflict.ts'],
      },
      {
        graph: createTestWorkerTaskGraph(graph),
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )
    expect(first.routeDecision.action).toBe('allow')

    const isolatedExecution = await acquireWorkerExecution(
      {
        taskId: 'isolated-writer',
        owner: 'worker-isolated',
        schedulerScope: 'integration-isolation',
        effort: 'max',
        writeSet: ['src/conflict.ts'],
        isolation: 'worktree',
      },
      {
        graph: createTestWorkerTaskGraph(graph),
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )

    expect(isolatedExecution.routeDecision).toMatchObject({
      action: 'worktree_isolated',
      allowed: true,
      blocked_by: [],
    })
    expect(scheduler.snapshot()).toMatchObject({
      activeWorkers: 2,
      activeWeight: SWARM_EFFORT_WEIGHTS.high + SWARM_EFFORT_WEIGHTS.max,
    })
    await first.complete()
    await isolatedExecution.release()
    expect(graph.requireTask('shared-writer').status).toBe('completed')
    expect(graph.requireTask('isolated-writer').status).toBe('pending')
    expect(scheduler.snapshot().activeWeight).toBe(0)
  })

  test('atomic claim race produces exactly one winner', async () => {
    const graph = createGraph()
    const firstDirectory = temporaryDirectories[0]
    if (!firstDirectory) throw new Error('test directory was not created')
    const databasePath = join(firstDirectory, 'tasks.db')
    const competingGraph = new TaskGraph({ databasePath })
    openGraphs.push(competingGraph)
    graph.route({ id: 'claim-race', write_set: ['src/race.ts'] })

    const results = await Promise.all([
      Promise.resolve().then(() => graph.claimTask('claim-race', 'agent-a')),
      Promise.resolve().then(() => competingGraph.claimTask('claim-race', 'agent-b')),
    ])

    expect(results.filter(result => result.ok)).toHaveLength(1)
    expect(results.filter(result => !result.ok)).toHaveLength(1)
    expect(graph.requireTask('claim-race').status).toBe('claimed')
    expect(graph.getTaskLease('claim-race')).not.toBeNull()
  })

  test('supports every fixed Luna worker effort, including none, xhigh, and max', async () => {
    const graph = createGraph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy({ budget: 8 })
    const efforts: WorkerEffort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
    const observed: WorkerEffort[] = []

    for (const [index, effort] of efforts.entries()) {
      const execution = await acquireWorkerExecution(
        {
          taskId: `effort-${index}`,
          owner: `worker-${effort}`,
          schedulerScope: 'integration-efforts',
          effort,
          writeSet: [`src/${effort}.ts`],
        },
        {
          graph: createTestWorkerTaskGraph(graph),
          acquireSchedulerLease: (scope, selectedEffort, signal) => {
            observed.push(selectedEffort)
            return scheduler.acquire(scope, { effort: selectedEffort, signal })
          },
        },
      )
      expect(execution.effort).toBe(effort)
      expect(scheduler.snapshot().activeWeight).toBe(
        SWARM_EFFORT_WEIGHTS[effort],
      )
      await execution.complete()
    }

    expect(observed).toEqual(efforts)
    expect(scheduler.snapshot().activeWeight).toBe(0)
  })

  test('returns only schema-valid JSON report data to the Leader', () => {
    const transcript = 'FULL WORKER TRANSCRIPT: hidden tool calls and prompts'
    const report = buildWorkerReport({
      taskId: 'report-only',
      status: 'completed',
      declaredChangedFiles: ['src/actual.ts'],
      finalText: JSON.stringify(
        validWorkerReport({
          changed_files: ['src/worker.ts'],
          summary: 'Report contains only bounded structured evidence.',
          tokens_used: 999999,
          effort_used: 'max',
        }),
      ),
      tokensUsed: 19,
      effortUsed: 'xhigh',
    })

    const serialized = serializeWorkerReport(report)
    const parsed: unknown = JSON.parse(serialized)
    expect(parsed).toMatchObject({
      schema_version: 'worker-report/1',
      task_id: 'report-only',
      run_id: 'report-only',
      worker_id: 'report-only',
      status: 'completed',
      changed_files: ['src/actual.ts', 'src/worker.ts'],
      tokens_used: 19,
      effort_used: 'xhigh',
      model: 'gpt-5.6-luna',
      validation: { verdict: 'pass' },
    })
    expect(serialized).not.toContain(transcript)
    expect(Object.keys(parsed as object).sort()).toEqual([
      'blockers',
      'changed_files',
      'effort_used',
      'evidence',
      'model',
      'policy_digest',
      'policy_epoch',
      'report_id',
      'run_id',
      'schema_version',
      'status',
      'summary',
      'task_id',
      'tokens_used',
      'validation',
      'worker_id',
    ])
  })

  test('invalid report fails the worker lifecycle instead of completing it', async () => {
    const graph = createGraph()
    const scheduler = new AdaptiveSwarmConcurrencyPolicy({ budget: 4 })
    const execution = await acquireWorkerExecution(
      {
        taskId: 'invalid-lifecycle-report',
        owner: 'worker-invalid-report',
        schedulerScope: 'integration-invalid-report',
        effort: 'high',
      },
      {
        graph: createTestWorkerTaskGraph(graph),
        acquireSchedulerLease: (scope, effort, signal) =>
          scheduler.acquire(scope, { effort, signal }),
      },
    )
    const report = buildWorkerReport({
      taskId: execution.taskId,
      runId: 'invalid-run',
      workerId: 'worker-invalid-report',
      status: 'completed',
      finalText: 'free-form worker output',
      tokensUsed: 3,
      effortUsed: 'high',
      policyEpoch: 0,
      policyDigest: '0'.repeat(64),
    })
    const events: string[] = []
    let settlement: Promise<void> | undefined
    const accepted = persistValidatedWorkerReport(
      { workerReport: report },
      {
        persist: () => events.push('persist'),
        complete: () => {
          events.push('complete')
          settlement = execution.complete()
        },
        reject: () => {
          events.push('reject')
          settlement = execution.fail()
        },
      },
      { policyEpoch: 0, policyDigest: '0'.repeat(64) },
    )

    expect(accepted).toBe(false)
    await settlement
    expect(events).toEqual(['reject'])
    expect(graph.requireTask(execution.taskId).status).toBe('failed')
    expect(scheduler.snapshot().activeWeight).toBe(0)
  })
})
