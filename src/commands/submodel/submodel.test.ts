import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

let configuredModel = 'gpt-5.6-luna'
const subagentModelMock = () => ({
  FIXED_SUBAGENT_MODEL: 'gpt-5.6-luna',
  FIXED_SUBAGENT_MODEL_DISPLAY: 'GPT-5.6 Luna',
  getConfiguredSubagentModel: () => configuredModel,
  setConfiguredSubagentModel: (model: string) => {
    configuredModel = model
    return model
  },
})
mock.module('../../utils/model/subagentModel.js', subagentModelMock)
mock.module(
  new URL('../../utils/model/subagentModel.ts', import.meta.url).pathname,
  subagentModelMock,
)
const settingsMock = () => ({
  updateSettingsForSource: () => ({ error: null }),
})
mock.module('../../utils/settings/settings.js', settingsMock)
mock.module(
  new URL('../../utils/settings/settings.ts', import.meta.url).pathname,
  settingsMock,
)

const { configureVexzyModelCatalog, resetVexzyModelCatalog } = await import(
  '../../services/api/vexzy/modelCatalog.js'
)
const { createVexzyModelRegistry } = await import(
  '../../services/api/vexzy/modelRegistry.js'
)
const {
  ensureSubmodelCatalogReady,
  getSubmodelOptions,
  setSubmodel,
} = await import('./modelSelection.js')

const model = (
  id: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: id,
  available: true,
  context_length: 1_100_000,
  supported_reasoning_efforts: ['none', 'low', 'medium', 'high'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: false },
  ...overrides,
})

let catalogLoads = 0

beforeEach(async () => {
  configuredModel = 'gpt-5.6-luna'
  catalogLoads = 0
  const registry = createVexzyModelRegistry({
    object: 'list',
    data: [
      model('gpt-5.6-luna'),
      model('gpt-5.6-terra'),
      model('text-only', {
        capabilities: { reasoning: true, tools: false, vision: false },
      }),
      model('offline-tool-model', { available: false }),
    ],
  })
  const catalog = configureVexzyModelCatalog({
    getModels: async () => {
      catalogLoads += 1
      return registry
    },
    refresh: async () => registry,
    getSnapshot: () => undefined,
  })
  await catalog.load()
})

afterEach(() => resetVexzyModelCatalog())

describe('/submodel', () => {
  test('reuses the ready catalog without entering a loading UI state', async () => {
    await ensureSubmodelCatalogReady()
    expect(getSubmodelOptions()).toHaveLength(2)
    expect(catalogLoads).toBe(1)
  })

  test('offers only available VEXZY models with tool execution', () => {
    expect(getSubmodelOptions().map(option => option.value)).toEqual([
      'gpt-5.6-luna',
      'gpt-5.6-terra',
    ])
  })

  test('persists the exact selection without changing the Leader model', async () => {
    await expect(setSubmodel('gpt-5.6-terra')).resolves.toContain(
      'gpt-5.6-terra',
    )
    expect(configuredModel).toBe('gpt-5.6-terra')
  })

  test('rejects unavailable and non-tool models', async () => {
    await expect(setSubmodel('text-only')).rejects.toThrow(/tool model/)
    await expect(setSubmodel('offline-tool-model')).rejects.toThrow(
      /tool model/,
    )
  })
})
