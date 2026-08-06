import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test'

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
const {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} = await import('../../../services/api/vexzy/modelCatalog.js')
const { createVexzyModelRegistry } = await import(
  '../../../services/api/vexzy/modelRegistry.js'
)
const { getSwarmWorkerWeight } = await import('../concurrencyPolicy.js')
const {
  applyWorkerRuntimeToAppState,
  DEFAULT_WORKER_EFFORT,
  resolveWorkerEffort,
  resolveWorkerRuntime,
  WORKER_EFFORT_LEVELS,
} = await import('./types.js')

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
      supported_reasoning_efforts: [
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ],
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

describe('worker effort resolution', () => {
  test('includes every fixed Luna effort level', () => {
    expect(WORKER_EFFORT_LEVELS).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  test('defaults only undefined and null to medium', () => {
    expect(DEFAULT_WORKER_EFFORT).toBe('medium')
    expect(resolveWorkerEffort(undefined)).toBe('medium')
    expect(resolveWorkerEffort(null)).toBe('medium')
    expect(() => resolveWorkerEffort('')).toThrow('Invalid Worker effort')
  })

  test('rejects Leader-only, numeric, and unknown effort values', () => {
    for (const invalid of [95, 'auto', 'minimal', 'leader-effort']) {
      expect(() => resolveWorkerEffort(invalid)).toThrow(
        'Invalid Worker effort',
      )
    }
  })

  test('preserves explicit worker effort', () => {
    for (const effort of WORKER_EFFORT_LEVELS) {
      expect(resolveWorkerEffort(effort)).toBe(effort)
    }
  })

  test('rejects worker effort that Luna does not advertise', async () => {
    const limitedRegistry = createVexzyModelRegistry({
      object: 'list',
      data: [
        {
          id: 'gpt-5.6-luna',
          object: 'model',
          owned_by: 'vexzy',
          display_name: 'GPT-5.6 Luna',
          available: true,
          context_length: 1_100_000,
          supported_reasoning_efforts: ['none', 'low'],
          input_modalities: ['text'],
          output_modalities: ['text'],
          capabilities: { reasoning: true, tools: true, vision: false },
        },
      ],
    })
    const catalog = configureVexzyModelCatalog({
      getModels: async () => limitedRegistry,
      refresh: async () => limitedRegistry,
      getSnapshot: () => undefined,
    })
    await catalog.load()

    expect(() => resolveWorkerRuntime('max')).toThrow(
      'does not advertise worker effort "max"',
    )
  })

  test('fails clearly when the VEXZY catalog is not ready', () => {
    resetVexzyModelCatalog()

    expect(() => resolveWorkerRuntime('medium')).toThrow(
      'VEXZY model catalog is not ready',
    )
  })

  test('pins every worker runtime to Luna without inheriting Leader effort', () => {
    expect(resolveWorkerRuntime(undefined)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'medium',
    })
    for (const effort of WORKER_EFFORT_LEVELS) {
      expect(resolveWorkerRuntime(effort)).toEqual({
        model: 'gpt-5.6-luna',
        effort,
      })
    }
  })

  test('projects per-worker effort onto the query AppState boundary', () => {
    const leaderState = {
      effortValue: 'max',
      leaderOnlyValue: 'preserved',
    }
    const workerRuntime = resolveWorkerRuntime('low')
    const workerState = applyWorkerRuntimeToAppState(
      leaderState,
      workerRuntime,
    )

    expect(leaderState.effortValue).toBe('max')
    expect(workerState.effortValue).toBe('low')
    expect(workerState.leaderOnlyValue).toBe('preserved')
  })

  test('resolved effort maps to the weighted scheduler lease cost', () => {
    expect(getSwarmWorkerWeight(resolveWorkerEffort(undefined))).toBe(2)
    expect(getSwarmWorkerWeight(resolveWorkerEffort('max'))).toBe(8)
    expect(getSwarmWorkerWeight(resolveWorkerEffort('none'))).toBe(1)
  })
})
