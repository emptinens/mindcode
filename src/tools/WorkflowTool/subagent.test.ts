import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)
mock.module('src/entrypoints/sdk/runtimeTypes.js', () => ({}))
mock.module(
  new URL('../../entrypoints/sdk/runtimeTypes.ts', import.meta.url).pathname,
  () => ({}),
)

const { configureVexzyModelCatalog, resetVexzyModelCatalog } = await import(
  '../../services/api/vexzy/modelCatalog.js'
)
const { createVexzyModelRegistry } = await import(
  '../../services/api/vexzy/modelRegistry.js'
)
const { resolveWorkerRuntime, WORKER_EFFORT_LEVELS } = await import(
  '../../utils/swarm/backends/types.js'
)

const workflowSubagentSource = readFileSync(
  new URL('./subagent.ts', import.meta.url),
  'utf8',
)
const workflowVmSource = readFileSync(new URL('./vm.ts', import.meta.url), 'utf8')

const workerRegistry = createVexzyModelRegistry({
  object: 'list',
  data: [
    {
      id: 'gpt-5.6-luna',
      object: 'model',
      owned_by: 'vexzy',
      display_name: 'GPT-5.6 Luna',
      available: true,
      context_length: 1_100_000,
      supported_reasoning_efforts: [...WORKER_EFFORT_LEVELS],
      input_modalities: ['text'],
      output_modalities: ['text'],
      capabilities: { reasoning: true, tools: true, vision: false },
    },
  ],
})

beforeEach(async () => {
  const catalog = configureVexzyModelCatalog({
    getModels: async () => workerRegistry,
    refresh: async () => workerRegistry,
    getSnapshot: () => undefined,
  })
  await catalog.load()
})

afterEach(() => {
  resetVexzyModelCatalog()
})

describe('Workflow worker runtime boundary', () => {
  test('resolves an omitted effort to medium on fixed Luna', () => {
    expect(resolveWorkerRuntime(undefined)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'medium',
    })
  })

  test.each(['low', 'max'] as const)(
    'passes explicit %s effort without changing the worker model',
    effort => {
      expect(resolveWorkerRuntime(effort)).toEqual({
        model: 'gpt-5.6-luna',
        effort,
      })
    },
  )

  test.each(['minimal', 'auto', 95] as const)(
    'rejects unsupported effort %s',
    effort => {
      expect(() => resolveWorkerRuntime(effort)).toThrow(
        'Invalid Worker effort',
      )
    },
  )

  test('Workflow admission resolves runtime before runAgent and forwards only resolved effort', () => {
    expect(workflowSubagentSource).toContain(
      'const workerRuntime = resolveWorkerRuntime(opts.effort)',
    )
    expect(workflowSubagentSource).toContain(
      'effort: workerRuntime.effort',
    )
    expect(workflowSubagentSource).toContain(
      'resolvedAgentModel: workerRuntime.model',
    )
    expect(workflowVmSource).toContain('effort: opts?.effort')
  })
})
