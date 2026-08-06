import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)
mock.module('src/entrypoints/sdk/runtimeTypes.js', () => ({}))
mock.module(
  new URL('../../../entrypoints/sdk/runtimeTypes.ts', import.meta.url).pathname,
  () => ({}),
)

const releasedLeaseIds: string[] = []
const releaseMailboxReport = mock(() => Promise.resolve(null))
const writeMailbox = mock(() => Promise.resolve())

mock.module(
  new URL('../concurrencyPolicy.ts', import.meta.url).pathname,
  () => ({
    acquireSwarmWorkerSlot: mock(),
    releaseSwarmWorkerSlot: (leaseId: string) => {
      releasedLeaseIds.push(leaseId)
      return true
    },
  }),
)
mock.module(
  new URL('../../../utils/teammateMailbox.ts', import.meta.url).pathname,
  () => ({
    createIdleNotification: (
      agentId: string,
      input: Record<string, unknown>,
    ) => ({
      type: 'idle_notification',
      agentId,
      ...input,
    }),
    isWorkerReportFreshAndCorrelated: () => false,
    readLatestWorkerReportEnvelope: releaseMailboxReport,
    resolveWorkerReportTerminalStatus: () => 'failed',
    writeToMailbox: writeMailbox,
  }),
)
mock.module(
  new URL('../teamHelpers.ts', import.meta.url).pathname,
  () => ({
    readTeamFile: () => ({
      leadAgentId: 'lead@team',
      members: [{ agentId: 'lead@team', name: 'team-lead' }],
    }),
  }),
)
mock.module(
  new URL('../workerTeamReport.ts', import.meta.url).pathname,
  () => ({
    buildWorkerTeamReport: () => ({
      schema_version: 'worker-report/1',
      task_id: 'task-1',
      run_id: 'run-1',
      worker_id: 'worker@team',
      model: 'gpt-5.6-luna',
      effort_used: 'medium',
      policy_epoch: 0,
      status: 'failed',
      summary: 'worker report unavailable',
      changed_files: [],
      evidence: [],
      tokens_used: 0,
      validation: { verdict: 'fail' },
      blockers: [],
    }),
    serializeWorkerTeamReportMessage: (message: unknown) =>
      JSON.stringify(message),
  }),
)
mock.module(
  new URL('../types.ts', import.meta.url).pathname,
  () => ({
    resolveWorkerRuntime: () => ({ model: 'gpt-5.6-luna', effort: 'medium' }),
  }),
)
mock.module(
  new URL('../spawnUtils.ts', import.meta.url).pathname,
  () => ({
    buildInheritedCliFlags: () => '',
    buildInheritedEnvVars: () => '',
    getTeammateCommand: () => 'mindcode',
  }),
)
mock.module(
  new URL('../teammateLayoutManager.ts', import.meta.url).pathname,
  () => ({ assignTeammateColor: () => 'blue' }),
)
mock.module(
  new URL('./detection.ts', import.meta.url).pathname,
  () => ({ isInsideTmux: async () => false }),
)
mock.module(
  new URL('../../../utils/cleanupRegistry.ts', import.meta.url).pathname,
  () => ({ registerCleanup: () => undefined }),
)
mock.module(
  new URL('../../../utils/debug.ts', import.meta.url).pathname,
  () => ({ logForDebugging: () => undefined }),
)
const { PaneBackendExecutor } = await import('./PaneBackendExecutor.js')

type ExecutorInternals = {
  spawnedTeammates: Map<string, Record<string, unknown>>
  releaseTrackedTeammate: (
    agentId: string,
    requestedStatus?: 'completed' | 'killed',
  ) => Promise<boolean>
  reconcileTeammateLifecycle: (agentId: string) => Promise<boolean>
}

type TestTask = {
  id: string
  type: 'in_process_teammate'
  status: 'running' | 'failed' | 'killed'
  startTime: number
  identity: { agentId: string }
}

type TestState = { tasks: Record<string, TestTask> }

function getTask(state: TestState, taskId: string): TestTask {
  const task = state.tasks[taskId]
  if (!task) throw new Error(`Missing test task: ${taskId}`)
  return task
}

function setupExecutor(backend: Record<string, unknown> = { type: 'tmux' }) {
  const state: TestState = {
    tasks: {
      'task-1': {
        id: 'task-1',
        type: 'in_process_teammate',
        status: 'running',
        startTime: 100,
        identity: { agentId: 'worker@team' },
      },
    },
  }
  let currentState = state
  const executor = new PaneBackendExecutor(backend as never)
  executor.setContext({
    getAppState: () => currentState,
    setAppState: (update: (previous: typeof state) => typeof state) => {
      currentState = update(currentState)
    },
  } as never)

  const internals = executor as unknown as ExecutorInternals
  internals.spawnedTeammates.set('worker@team', {
    paneId: 'pane-1',
    insideTmux: true,
    concurrencyLeaseId: 'lease-1',
    teamName: 'team',
    seenInTeamFile: true,
    workerEffort: 'medium',
    taskId: 'task-1',
    workerRunId: 'run-1',
    lifecycleStartedAtMs: Date.now(),
  })

  return {
    executor,
    internals,
    getState: () => currentState,
    setState: (update: (previous: typeof state) => typeof state) => {
      currentState = update(currentState)
    },
  }
}

describe('pane teammate release failure handling', () => {
  test('mailbox read failure still releases lease and fails the task', async () => {
    releasedLeaseIds.length = 0
    releaseMailboxReport.mockImplementation(async () => {
      throw new Error('mailbox read failed')
    })
    writeMailbox.mockClear()

    const { internals, getState } = setupExecutor()
    await expect(internals.releaseTrackedTeammate('worker@team')).resolves.toBe(
      true,
    )

    expect(releasedLeaseIds).toEqual(['lease-1'])
    expect(getTask(getState(), 'task-1')).toMatchObject({
      status: 'failed',
      identity: { agentId: 'worker@team' },
    })
    expect(writeMailbox).not.toHaveBeenCalled()
    expect(internals.spawnedTeammates.has('worker@team')).toBe(false)
  })

  test('mailbox write failure cannot complete the task or retain the lease', async () => {
    releasedLeaseIds.length = 0
    releaseMailboxReport.mockImplementation(async () => null)
    writeMailbox.mockImplementation(async () => {
      throw new Error('mailbox write failed')
    })

    const { internals, getState } = setupExecutor()
    await expect(internals.releaseTrackedTeammate('worker@team')).resolves.toBe(
      true,
    )

    expect(releasedLeaseIds).toEqual(['lease-1'])
    expect(getTask(getState(), 'task-1').status).toBe('failed')
    expect(internals.spawnedTeammates.has('worker@team')).toBe(false)
  })

  test('stale release cannot terminalize a reused agent task', async () => {
    releasedLeaseIds.length = 0
    writeMailbox.mockImplementation(async () => {})

    let resolveMailboxRead: ((value: null) => void) | undefined
    releaseMailboxReport.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveMailboxRead = resolve
        }),
    )

    const { internals, getState, setState } = setupExecutor()
    const releasePromise = internals.releaseTrackedTeammate('worker@team')
    expect(resolveMailboxRead).toBeFunction()

    setState(() => ({
      tasks: {
        'task-2': {
          id: 'task-2',
          type: 'in_process_teammate',
          status: 'running',
          startTime: 200,
          identity: { agentId: 'worker@team' },
        },
      },
    }))
    resolveMailboxRead?.(null)
    await releasePromise

    expect(releasedLeaseIds).toEqual(['lease-1'])
    expect(getTask(getState(), 'task-2')).toMatchObject({
      status: 'running',
      id: 'task-2',
    })
  })

  test('pane liveness errors fail the task and release the lease once', async () => {
    releasedLeaseIds.length = 0
    releaseMailboxReport.mockImplementation(async () => null)
    writeMailbox.mockImplementation(async () => {})
    const isPaneAlive = mock(async () => {
      throw new Error('liveness backend unavailable')
    })
    const { executor, getState } = setupExecutor({
      type: 'tmux',
      isPaneAlive,
    })

    await expect(executor.isActive('worker@team')).resolves.toBe(false)
    expect(isPaneAlive).toHaveBeenCalledTimes(1)
    expect(releasedLeaseIds).toEqual(['lease-1'])
    expect(getTask(getState(), 'task-1').status).toBe('failed')
  })

  test('concurrent kill and reconcile release one lease and one terminal transition', async () => {
    releasedLeaseIds.length = 0
    releaseMailboxReport.mockImplementation(async () => null)
    writeMailbox.mockImplementation(async () => {})
    let resolveKill: ((value: boolean) => void) | undefined
    const killPane = mock(
      () =>
        new Promise<boolean>(resolve => {
          resolveKill = resolve
        }),
    )
    const isPaneAlive = mock(async () => false)
    const { executor, internals, getState } = setupExecutor({
      type: 'tmux',
      killPane,
      isPaneAlive,
    })

    const killPromise = executor.kill('worker@team')
    const reconcilePromise = internals.reconcileTeammateLifecycle(
      'worker@team',
    )
    resolveKill?.(true)
    await expect(Promise.all([killPromise, reconcilePromise])).resolves.toEqual([
      true,
      false,
    ])

    expect(releasedLeaseIds).toEqual(['lease-1'])
    expect(getTask(getState(), 'task-1').status).toBe('failed')
    expect(internals.spawnedTeammates.has('worker@team')).toBe(false)
  })
})
