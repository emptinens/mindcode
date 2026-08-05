import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)
import {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import { createVexzyModelClient } from '../../services/api/vexzy/modelClient.js'

const { filterModelOptionsByAvailableModels, getModelOptions } = await import(
  './modelOptions.js'
)

const model = (id: string, available = true) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: `Dynamic ${id}`,
  available,
  ...(available ? {} : { status: 'maintenance' }),
  context_length: 1_000_000,
  supported_reasoning_efforts: ['none', 'medium', 'max'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: false },
})

describe('Vexzy model options compatibility API', () => {
  test('uses only the last Vexzy snapshot at runtime', async () => {
    const previousKey = process.env.VEXZY_API_KEY
    process.env.VEXZY_API_KEY = 'forge-model-options-key'

    const client = createVexzyModelClient({
      apiKey: 'forge-model-options-key',
      fetch: async () =>
        new Response(
          JSON.stringify({
            object: 'list',
            data: [model('exact-dynamic-id'), model('offline-id', false)],
          }),
          { status: 200 },
        ),
    })
    const catalog = configureVexzyModelCatalog(client)

    try {
      expect(getModelOptions()).toEqual([])
      await catalog.load()

      const options = getModelOptions()
      expect(options.map(option => option.value)).toEqual([
        'exact-dynamic-id',
        'offline-id',
      ])
      expect(options[0]).toMatchObject({
        displayName: 'Dynamic exact-dynamic-id',
        contextLength: 1_000_000,
        supportedReasoningEfforts: ['none', 'medium', 'max'],
      })
      expect(options[1]).toMatchObject({
        disabled: true,
        unavailable: true,
      })
      expect(options.some(option => option.value === 'gpt-5.6-luna')).toBe(
        false,
      )
    } finally {
      resetVexzyModelCatalog()
      if (previousKey === undefined)
        Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
      else process.env.VEXZY_API_KEY = previousKey
    }
  })

  test('filters dynamic options by the availableModels allowlist', () => {
    const options = [
      { value: 'allowed-id', label: 'Allowed', description: 'Allowed' },
      { value: 'blocked-id', label: 'Blocked', description: 'Blocked' },
    ]

    expect(
      filterModelOptionsByAvailableModels(options, ['allowed-id']).map(
        option => option.value,
      ),
    ).toEqual(['allowed-id'])
  })
})
