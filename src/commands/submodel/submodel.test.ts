import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const subagentModelMock = () => ({
  FIXED_SUBAGENT_MODEL: 'gpt-5.6-luna',
  FIXED_SUBAGENT_MODEL_DISPLAY: 'GPT-5.6 Luna',
  getConfiguredSubagentModel: () => 'gpt-5.6-luna',
  setConfiguredSubagentModel: () => 'gpt-5.6-luna',
})
mock.module('../../utils/model/subagentModel.js', subagentModelMock)
mock.module(
  new URL('../../utils/model/subagentModel.ts', import.meta.url).pathname,
  subagentModelMock,
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
    expect(getSubmodelOptions()).toHaveLength(1)
    expect(catalogLoads).toBe(1)
  })

  test('offers only the fixed Luna model when it is available for tools', () => {
    expect(getSubmodelOptions().map(option => option.value)).toEqual([
      'gpt-5.6-luna',
    ])
  })

  test('reports the fixed model without persisting a mutable selection', async () => {
    await expect(setSubmodel('gpt-5.6-luna')).resolves.toContain(
      'fixed to gpt-5.6-luna',
    )
  })

  test('rejects every alternate Worker model even when it supports tools', async () => {
    await expect(setSubmodel('gpt-5.6-terra')).rejects.toThrow(
      /fixed to gpt-5\.6-luna/,
    )
    await expect(setSubmodel('text-only')).rejects.toThrow(/fixed to/)
  })
})
