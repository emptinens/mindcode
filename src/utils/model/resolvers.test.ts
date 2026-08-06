import { afterEach, describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} = await import('../../services/api/vexzy/modelCatalog.js')
const { createVexzyModelRegistry } = await import(
  '../../services/api/vexzy/modelRegistry.js'
)
const {
  DEFAULT_WORKER_EFFORT,
  FixedSubagentModelUnavailableError,
  InvalidWorkerEffortError,
  LeaderModelResolver,
  LeaderModelUnavailableError,
  WorkerEffortResolver,
  WorkerModelResolver,
  WORKER_EFFORT_LEVELS,
} = await import('./resolvers.js')

const luna = (overrides: Record<string, unknown> = {}) => ({
  id: 'gpt-5.6-luna',
  object: 'model' as const,
  owned_by: 'vexzy' as const,
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
  ...overrides,
})

const terra = () => ({
  ...luna(),
  id: 'gpt-5.6-terra',
  display_name: 'GPT-5.6 Terra',
})

async function loadCatalog(...models: ReturnType<typeof luna>[]) {
  const registry = createVexzyModelRegistry({ object: 'list', data: models })
  const catalog = configureVexzyModelCatalog({
    getModels: async () => registry,
    refresh: async () => registry,
    getSnapshot: () => undefined,
  })
  await catalog.load()
}

afterEach(() => {
  resetVexzyModelCatalog()
})

describe('public model and effort resolver boundaries', () => {
  test('LeaderModelResolver selects the first available exact catalog model', async () => {
    await loadCatalog(luna(), terra())
    expect(new LeaderModelResolver().resolveDefaultModel()).toBe(
      'gpt-5.6-luna',
    )
  })

  test('LeaderModelResolver fails closed before catalog readiness', () => {
    resetVexzyModelCatalog()
    expect(() => new LeaderModelResolver().resolveDefaultModel()).toThrow(
      LeaderModelUnavailableError,
    )
  })

  test('LeaderModelResolver allows Luna when it is the only available model', async () => {
    await loadCatalog(luna())
    expect(new LeaderModelResolver().resolveDefaultModel()).toBe('gpt-5.6-luna')
  })

  test('LeaderModelResolver fails closed when the catalog has no available model', async () => {
    await loadCatalog(luna({ available: false }))
    expect(() => new LeaderModelResolver().resolveDefaultModel()).toThrow(
      /catalog has no available model/,
    )
  })

  test('WorkerModelResolver always returns Luna after catalog validation', async () => {
    await loadCatalog(luna(), terra())
    const resolver = new WorkerModelResolver()
    expect(resolver.fixedModel).toBe('gpt-5.6-luna')
    expect(resolver.resolve()).toBe('gpt-5.6-luna')
  })

  test('WorkerModelResolver fails closed when the catalog is not ready', () => {
    resetVexzyModelCatalog()
    expect(() => new WorkerModelResolver().resolve()).toThrow(
      FixedSubagentModelUnavailableError,
    )
  })

  test('WorkerEffortResolver uses medium only for missing input', () => {
    const resolver = new WorkerEffortResolver()
    expect(DEFAULT_WORKER_EFFORT).toBe('medium')
    expect(resolver.resolve(undefined)).toBe('medium')
    expect(resolver.resolve(null)).toBe('medium')
    expect(resolver.resolve('max')).toBe('max')
    expect(WORKER_EFFORT_LEVELS).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  test('WorkerEffortResolver rejects Leader-only and unknown values', () => {
    const resolver = new WorkerEffortResolver()
    for (const value of ['minimal', 'auto', 95, 'unknown']) {
      expect(() => resolver.resolve(value)).toThrow(InvalidWorkerEffortError)
    }
  })

  test('WorkerEffortResolver validates effort against Luna capabilities', async () => {
    await loadCatalog(luna({ supported_reasoning_efforts: ['none', 'low'] }))
    expect(() =>
      new WorkerEffortResolver().resolveForModel('max', 'gpt-5.6-luna'),
    ).toThrow(/does not advertise worker effort "max"/)
  })
})
