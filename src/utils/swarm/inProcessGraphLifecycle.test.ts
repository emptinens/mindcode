import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import type { WorkerReport } from '../../tools/AgentTool/workerReport.js'
import { getConfiguredSubagentModel } from '../../utils/model/subagentModel.js'

const modulePath = (relativePath: string) =>
  new URL(relativePath, import.meta.url).pathname

const policy = {
  policyEpoch: 7,
  policyDigest: 'a'.repeat(64),
} as const
const policyMock = () => ({
  assertWorkerPolicyIdentity: (value: typeof policy) => value,
  getWorkerPolicyIdentity: () => policy,
  parsePolicyEpochEnvironment: () => undefined,
  readCurrentPolicyEpochState: () => undefined,
  resolvePolicyEpochForSource: () => ({ epoch: policy.policyEpoch }),
  POLICY_DIGEST_ENV_VAR: 'MINDCODE_POLICY_DIGEST',
  POLICY_EPOCH_ENV_VAR: 'MINDCODE_POLICY_EPOCH',
})
mock.module('src/services/policy/index.js', policyMock)
mock.module(modulePath('../../services/policy/index.js'), policyMock)
mock.module(modulePath('../../services/policy/index.ts'), policyMock)

const workerPolicySourceMock = () => ({
  getWorkerPolicyIdentity: () => policy,
  getWorkerPolicySourceDigest: () => policy.policyDigest,
  getCompiledWorkerPolicySnapshot: () => ({
    policyEpoch: policy.policyEpoch,
    sourceDigest: policy.policyDigest,
    prompt: '',
  }),
  getWorkerPolicySourceSections: () => [],
})
mock.module('src/services/policy/workerPolicySource.js', workerPolicySourceMock)
mock.module(
  modulePath('../../services/policy/workerPolicySource.js'),
  workerPolicySourceMock,
)
mock.module(
  modulePath('../../services/policy/workerPolicySource.ts'),
  workerPolicySourceMock,
)
const runtimeTypesMock = () => ({})
mock.module('src/entrypoints/sdk/runtimeTypes.js', runtimeTypesMock)
mock.module(modulePath('../../entrypoints/sdk/runtimeTypes.js'), runtimeTypesMock)
mock.module(modulePath('../../entrypoints/sdk/runtimeTypes.ts'), runtimeTypesMock)
const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(modulePath('../../entrypoints/agentSdkTypes.ts'), agentSdkTypesMock)
const toolsRegistryMock = () => ({
  ALL_AGENT_DISALLOWED_TOOLS: new Set<string>(),
  ASYNC_AGENT_ALLOWED_TOOLS: new Set<string>(),
  COORDINATOR_MODE_ALLOWED_TOOLS: new Set<string>(),
  CUSTOM_AGENT_DISALLOWED_TOOLS: new Set<string>(),
  assembleToolPool: () => [],
  filterToolsByDenyRules: () => [],
  getTools: () => [],
  getAllBaseTools: () => [],
  getToolsForDefaultPreset: () => [],
  parseToolPreset: () => null,
})
mock.module('src/tools.ts', toolsRegistryMock)
mock.module('src/tools.js', toolsRegistryMock)
mock.module(modulePath('../../tools.ts'), toolsRegistryMock)
const analyticsMock = () => ({
  logEvent: () => undefined,
})
mock.module('src/services/analytics/index.js', analyticsMock)
mock.module('src/services/analytics/index.ts', analyticsMock)
const memoryPathsMock = () => ({
  hasAutoMemPathOverride: () => false,
  isAutoMemPath: () => false,
  isAutoMemoryEnabled: () => false,
  getMemoryBaseDir: () => '/tmp/mindcode-memory',
  getAutoMemPath: () => '/tmp/mindcode-memory',
  getAutoMemEntrypoint: () => '/tmp/mindcode-memory/MINDCODE.md',
})
mock.module('src/memdir/paths.js', memoryPathsMock)
mock.module(modulePath('../../memdir/paths.js'), memoryPathsMock)
mock.module(modulePath('../../memdir/paths.ts'), memoryPathsMock)
const coreTypesMock = () => ({
  HOOK_EVENTS: ['PreToolUse'] as const,
  EXIT_REASONS: ['other'] as const,
})
mock.module('src/entrypoints/sdk/coreTypes.js', coreTypesMock)
mock.module(modulePath('../../entrypoints/sdk/coreTypes.js'), coreTypesMock)
mock.module(modulePath('../../entrypoints/sdk/coreTypes.ts'), coreTypesMock)
const boxMock = () => ({ Box: () => null, default: () => null })
mock.module('src/ink/components/Box.js', boxMock)
mock.module(modulePath('../../ink/components/Box.js'), boxMock)
mock.module(modulePath('../../ink/components/Box.tsx'), boxMock)
mock.module('color-diff-napi', () => ({
  ColorDiff: () => [],
  ColorFile: () => [],
  getSyntaxTheme: () => null,
}))
const taskDiskOutputMock = () => ({
  DiskTaskOutput: class {},
  MAX_TASK_OUTPUT_BYTES_DISPLAY: '5GB',
  MAX_TASK_OUTPUT_BYTES: 5 * 1024 * 1024 * 1024,
  evictTaskOutput: async () => undefined,
  getTaskOutput: async () => '',
  getTaskOutputDir: () => '/tmp/mindcode-task-output',
  getTaskOutputDelta: async () => '',
  getTaskOutputPath: () => '/tmp/mindcode-task-output',
  initTaskOutputAsSymlink: async () => undefined,
})
mock.module('src/utils/task/diskOutput.js', taskDiskOutputMock)
mock.module(modulePath('../../utils/task/diskOutput.js'), taskDiskOutputMock)
mock.module(modulePath('../../utils/task/diskOutput.ts'), taskDiskOutputMock)

const { getWorkerPolicyIdentity } = await import('../../services/policy/index.js')
const { WORKER_REPORT_SCHEMA_VERSION, buildWorkerReport } = await import(
  '../../tools/AgentTool/workerReport.js'
)
const { createTask, getTask } = await import('../tasks.js')
const { setTaskGraphDaemonClientForTests } = await import(
  '../taskGraphAdapter.js'
)
const {
  claimInProcessSharedTask,
  settleInProcessSharedTask,
} = await import('./inProcessSharedTask.js')

const fallbackTaskGraphClient = {
  routeWithFallback: async (
    _task: unknown,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  readWithFallback: async (
    _taskId: string,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  listWithFallback: async (
    _params: unknown,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  listDependentsWithFallback: async (
    _taskId: string,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  claimWithFallback: async (
    _request: unknown,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  updateWithFallback: async (
    _taskId: string,
    _patch: unknown,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
  routeUpdateWithFallback: async (
    _params: unknown,
    fallback: () => Promise<unknown>,
  ) => ({ source: 'fallback' as const, value: await fallback(), reason: 'disabled' as const }),
}

const originalConfigDir = process.env.MINDCODE_CONFIG_DIR
const originalDaemonDisabled = process.env.MINDCODE_DAEMON_DISABLED
const roots: string[] = []

afterEach(async () => {
  setTaskGraphDaemonClientForTests(undefined)
  if (originalConfigDir === undefined) Reflect.deleteProperty(process.env, 'MINDCODE_CONFIG_DIR')
  else process.env.MINDCODE_CONFIG_DIR = originalConfigDir
  if (originalDaemonDisabled === undefined)
    Reflect.deleteProperty(process.env, 'MINDCODE_DAEMON_DISABLED')
  else process.env.MINDCODE_DAEMON_DISABLED = originalDaemonDisabled
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

async function useGraphStore(): Promise<string> {
  const root = await mkdtemp('/tmp/mindcode-in-process-graph-')
  roots.push(root)
  process.env.MINDCODE_CONFIG_DIR = root
  process.env.MINDCODE_DAEMON_DISABLED = '1'
  setTaskGraphDaemonClientForTests(
    () => fallbackTaskGraphClient as never,
  )
  return root
}

function makeReport(
  taskId: string,
  policy: ReturnType<typeof getWorkerPolicyIdentity>,
  status: 'completed' | 'partial' = 'completed',
  runId = `run-${taskId}`,
): WorkerReport {
  return buildWorkerReport({
    taskId,
    runId,
    workerId: 'worker@team',
    policyEpoch: policy.policyEpoch,
    policyDigest: policy.policyDigest,
    status,
    effortUsed: 'medium',
    tokensUsed: 3,
    finalText:
      status === 'completed'
        ? JSON.stringify({
            schema_version: WORKER_REPORT_SCHEMA_VERSION,
            task_id: taskId,
            run_id: runId,
            worker_id: 'worker@team',
            report_id: '0'.repeat(64),
            model: getConfiguredSubagentModel(),
            effort_used: 'medium',
            policy_epoch: policy.policyEpoch,
            policy_digest: policy.policyDigest,
            status: 'completed',
            summary: 'graph lifecycle verified',
            changed_files: [],
            evidence: [
              { id: 'test-1', type: 'test', command: 'bun test', exit_code: 0 },
            ],
            tokens_used: 3,
            validation: { verdict: 'pass' },
            blockers: [],
          })
        : undefined,
  })
}

const runIdFor = (taskId: string) => `run-${taskId}`

async function createSharedTask(taskListId: string, subject: string) {
  return createTask(taskListId, {
    subject,
    description: 'actual shared work task',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    metadata: { kind: 'implement', effort: 'medium' },
  })
}

describe('in-process teammate authoritative graph lifecycle', () => {
  test('settles an actual shared task only after a validated report', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-contract'
    const taskId = await createSharedTask(taskListId, 'actual work')
    expect(await getTask(taskListId, taskId)).toMatchObject({
      id: taskId,
      status: 'pending',
    })

    await claimInProcessSharedTask(
      taskListId,
      taskId,
      'worker@team',
      runIdFor(taskId),
      policy,
    )
    const invalid = makeReport(taskId, policy, 'partial')
    expect(
      await settleInProcessSharedTask(
        taskListId,
        taskId,
        'worker@team',
        runIdFor(taskId),
        invalid,
        policy,
      ),
    ).toBe(false)
    expect(await getTask(taskListId, taskId)).toMatchObject({ status: 'failed' })
  })

  test('persists report identity before successful terminal completion', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-report'
    const taskId = await createSharedTask(taskListId, 'report-gated work')
    await claimInProcessSharedTask(
      taskListId,
      taskId,
      'worker@team',
      runIdFor(taskId),
      policy,
    )
    const report = makeReport(taskId, policy)
    expect(
      await settleInProcessSharedTask(
        taskListId,
        taskId,
        'worker@team',
        runIdFor(taskId),
        report,
        policy,
      ),
    ).toBe(true)
    expect(await getTask(taskListId, taskId)).toMatchObject({
      status: 'completed',
      metadata: {
        report_id: report.report_id,
        policy_epoch: report.policy_epoch,
        policy_digest: report.policy_digest,
      },
    })
  })

  test('a valid report for another task cannot complete the claimed task', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-correlation'
    const claimedTaskId = await createSharedTask(taskListId, 'claimed work')
    const otherTaskId = await createSharedTask(taskListId, 'other work')

    await claimInProcessSharedTask(
      taskListId,
      claimedTaskId,
      'worker@team',
      runIdFor(claimedTaskId),
      policy,
    )

    expect(
      await settleInProcessSharedTask(
        taskListId,
        claimedTaskId,
        'worker@team',
        runIdFor(claimedTaskId),
        makeReport(otherTaskId, policy),
        policy,
      ),
    ).toBe(false)
    expect(await getTask(taskListId, claimedTaskId)).toMatchObject({
      status: 'failed',
    })
    expect(await getTask(taskListId, otherTaskId)).toMatchObject({
      status: 'pending',
    })
  })

  test('a report from another worker cannot complete the claimed task', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-owner-correlation'
    const taskId = await createSharedTask(taskListId, 'owner-bound work')
    await claimInProcessSharedTask(
      taskListId,
      taskId,
      'worker@team',
      runIdFor(taskId),
      policy,
    )
    const report = makeReport(taskId, policy)
    const mismatchedReport = { ...report, worker_id: 'other-worker' }

    expect(
      await settleInProcessSharedTask(
        taskListId,
        taskId,
        'worker@team',
        runIdFor(taskId),
        mismatchedReport,
        policy,
      ),
    ).toBe(false)
    expect(await getTask(taskListId, taskId)).toMatchObject({
      status: 'failed',
    })
  })

  test('a stale report run cannot complete a new claim for the same task and worker', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-run-correlation'
    const taskId = await createSharedTask(taskListId, 'run-bound work')
    const currentRunId = runIdFor(taskId)
    await claimInProcessSharedTask(
      taskListId,
      taskId,
      'worker@team',
      currentRunId,
      policy,
    )

    const staleReport = makeReport(taskId, policy, 'completed', 'stale-run')
    expect(
      await settleInProcessSharedTask(
        taskListId,
        taskId,
        'worker@team',
        currentRunId,
        staleReport,
        policy,
      ),
    ).toBe(false)
    expect(await getTask(taskListId, taskId)).toMatchObject({
      status: 'failed',
      metadata: { worker_run_id: currentRunId },
    })
  })

  test('uses atomic claim/dependency checks for in-process work', async () => {
    await useGraphStore()
    const policy = getWorkerPolicyIdentity()
    const taskListId = 'session-dependencies'
    const dependency = await createSharedTask(taskListId, 'dependency')
    const dependent = await createTask(taskListId, {
      subject: 'dependent',
      description: 'actual dependent work task',
      status: 'pending',
      blocks: [],
      blockedBy: [dependency],
      metadata: { kind: 'implement', effort: 'medium' },
    })

    await expect(
      claimInProcessSharedTask(
        taskListId,
        dependent,
        'worker@team',
        runIdFor(dependent),
        policy,
      ),
    ).rejects.toThrow('blocked')

    await claimInProcessSharedTask(
      taskListId,
      dependency,
      'worker@team',
      runIdFor(dependency),
      policy,
    )
    expect(
      await settleInProcessSharedTask(
        taskListId,
        dependency,
        'worker@team',
        runIdFor(dependency),
        makeReport(dependency, policy),
        policy,
      ),
    ).toBe(true)
    await expect(
      claimInProcessSharedTask(
        taskListId,
        dependent,
        'worker@team',
        runIdFor(dependent),
        policy,
      ),
    ).resolves.toMatchObject({ id: dependent, status: 'running' })
  })
})
