import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { resetModelStringsForTestingOnly } = await import(
  'src/bootstrap/state.js'
)
import { createVexzyModelRegistry } from '../../services/api/vexzy/modelRegistry.js'
import {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
const { getModelStrings } = await import('./modelStrings.js')

const model = (id: string, available = true) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: id,
  available,
  ...(available ? {} : { status: 'maintenance' }),
  context_length: 1_000_000,
  supported_reasoning_efforts: ['none'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: false, tools: true, vision: false },
})

const previousEnvironment: Record<string, string | undefined> = {}
const providerEnvironment = [
  'VEXZY_API_KEY',
  'MINDCODE_USE_BEDROCK',
  'MINDCODE_USE_VERTEX',
  'MINDCODE_USE_FOUNDRY',
]

beforeEach(() => {
  for (const key of providerEnvironment) {
    previousEnvironment[key] = process.env[key]
  }
  process.env.VEXZY_API_KEY = 'forge-model-strings-key'
  Reflect.deleteProperty(process.env, 'MINDCODE_USE_BEDROCK')
  Reflect.deleteProperty(process.env, 'MINDCODE_USE_VERTEX')
  Reflect.deleteProperty(process.env, 'MINDCODE_USE_FOUNDRY')
  resetVexzyModelCatalog()
  resetModelStringsForTestingOnly()
})

afterEach(() => {
  resetVexzyModelCatalog()
  resetModelStringsForTestingOnly()
  for (const key of providerEnvironment) {
    const value = previousEnvironment[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('Vexzy model string compatibility bridge', () => {
  test('returns no legacy IDs while the catalog is cold', () => {
    const strings = getModelStrings()

    expect(strings).toEqual({})
  })

  test('returns only available exact IDs from a ready catalog', async () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model('claude-opus-5'), model('maintenance-model', false)],
        }),
      refresh: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model('claude-opus-5'), model('maintenance-model', false)],
        }),
      getSnapshot: () => undefined,
    })
    await catalog.load()

    const strings = getModelStrings()

    expect(strings['claude-opus-5']).toBe('claude-opus-5')
    expect(strings['maintenance-model']).toBeUndefined()
  })

  test('returns no legacy IDs for an unavailable catalog model', async () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model('claude-opus-5', false)],
        }),
      refresh: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model('claude-opus-5', false)],
        }),
      getSnapshot: () => undefined,
    })
    await catalog.load()

    const strings = getModelStrings()

    expect(strings).toEqual({})
  })

  test('returns no legacy IDs after a catalog error', async () => {
    const catalog = configureVexzyModelCatalog({
      getModels: async () => {
        throw new Error('catalog unavailable')
      },
      refresh: async () => {
        throw new Error('catalog unavailable')
      },
      getSnapshot: () => undefined,
    })
    await expect(catalog.load()).rejects.toThrow('catalog unavailable')

    const strings = getModelStrings()

    expect(Object.values(strings).every(value => value === '')).toBe(true)
  })

  test('clears previously resolved IDs when a ready catalog enters error', async () => {
    let refresh = false
    const catalog = configureVexzyModelCatalog({
      getModels: async () =>
        createVexzyModelRegistry({
          object: 'list',
          data: [model('claude-opus-5')],
        }),
      refresh: async () => {
        refresh = true
        throw new Error('catalog unavailable')
      },
      getSnapshot: () => undefined,
    })
    await catalog.load()
    expect(getModelStrings()['claude-opus-5']).toBe('claude-opus-5')

    await expect(catalog.refresh()).rejects.toThrow('catalog unavailable')
    expect(refresh).toBe(true)
    expect(getModelStrings()).toEqual({})
  })
})
