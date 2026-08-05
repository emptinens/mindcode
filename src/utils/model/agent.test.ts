import { afterEach, describe, expect, test } from 'bun:test'
import {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import { createVexzyModelRegistry } from '../../services/api/vexzy/modelRegistry.js'
import {
  FixedSubagentModelUnavailableError,
  getAgentModel,
  resolveFixedSubagentModel,
} from './agent.js'

const model = (overrides: Record<string, unknown> = {}) => ({
  id: 'gpt-5.6-luna',
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: 'GPT-5.6 Luna',
  available: true,
  context_length: 1_100_000,
  supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: false },
  ...overrides,
})

afterEach(() => {
  resetVexzyModelCatalog()
})

describe('fixed Luna subagent resolver', () => {
  test('fails closed before the VEXZY catalog is ready', () => {
    resetVexzyModelCatalog()
    expect(() => resolveFixedSubagentModel()).toThrow(
      FixedSubagentModelUnavailableError,
    )
    expect(() => resolveFixedSubagentModel()).toThrow(/catalog is not ready/)
  })

  test('fails closed when Luna is absent from the ready catalog', async () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [model({ id: 'gpt-5.6-terra' })],
    })
    const catalog = configureVexzyModelCatalog({
      getModels: async () => registry,
      refresh: async () => registry,
      getSnapshot: () => undefined,
    })
    await catalog.load()
    expect(() => resolveFixedSubagentModel()).toThrow(/absent from catalog/)
  })

  test('fails closed when Luna is unavailable', () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model({ available: false, status: 'maintenance' })],
        }),
      refresh: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model({ available: false, status: 'maintenance' })],
        }),
      getSnapshot: () => undefined,
    })
    return catalog.load().then(() => {
      expect(() => resolveFixedSubagentModel()).toThrow(/not available/)
    })
  })

  test('fails closed when Luna lacks tool capability', async () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [
            model({
              capabilities: { reasoning: true, tools: false, vision: false },
            }),
          ],
        }),
      refresh: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [
            model({
              capabilities: { reasoning: true, tools: false, vision: false },
            }),
          ],
        }),
      getSnapshot: () => undefined,
    })
    await catalog.load()
    expect(() => resolveFixedSubagentModel()).toThrow(
      /tool execution/,
    )
  })

  test('resolves only Luna after ready availability and tool checks', async () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({ object: 'list', data: [model()] }),
      refresh: async () =>
        createVexzyModelRegistry({ object: 'list', data: [model()] }),
      getSnapshot: () => undefined,
    })
    await catalog.load()

    expect(resolveFixedSubagentModel()).toBe('gpt-5.6-luna')
    expect(getAgentModel('opus', 'gpt-5.6-sol', 'haiku')).toBe(
      'gpt-5.6-luna',
    )
  })
})
