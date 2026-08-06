import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { getMainLoopModelOverride, setMainLoopModelOverride } = await import(
  '../../bootstrap/state.js'
)
const { getDefaultMainLoopModel, getUserSpecifiedModelSetting } = await import(
  './model.js'
)
const {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} = await import('../../services/api/vexzy/modelCatalog.js')
const { createVexzyModelClient } = await import(
  '../../services/api/vexzy/modelClient.js'
)

describe('model environment selection', () => {
  test('prefers an exact MINDCODE_MODEL over the legacy environment variable', async () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousLegacyModel = process.env.ANTHROPIC_MODEL
    const previousOverride = getMainLoopModelOverride()
    const catalog = configureVexzyModelCatalog(
      createVexzyModelClient({
        apiKey: 'forge-test-key',
        fetch: async () =>
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: 'opaque-leader:v2',
                  object: 'model',
                  owned_by: 'vexzy',
                  display_name: 'Opaque Leader',
                  available: true,
                  context_length: 1_000_000,
                  supported_reasoning_efforts: ['low', 'medium', 'high'],
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                  capabilities: {
                    reasoning: true,
                    tools: true,
                    vision: false,
                  },
                },
              ],
            }),
          ),
      }),
    )

    try {
      await catalog.load()
      setMainLoopModelOverride(undefined)
      process.env.MINDCODE_MODEL = 'opaque-leader:v2'
      process.env.ANTHROPIC_MODEL = 'legacy-provider-model'

      expect(getUserSpecifiedModelSetting()).toBe('opaque-leader:v2')
    } finally {
      resetVexzyModelCatalog()
      setMainLoopModelOverride(previousOverride)
      if (previousModel === undefined) {
        // biome-ignore lint/performance/noDelete: restore the exact process environment state
        delete process.env.MINDCODE_MODEL
      } else process.env.MINDCODE_MODEL = previousModel
      if (previousLegacyModel === undefined) {
        // biome-ignore lint/performance/noDelete: restore the exact process environment state
        delete process.env.ANTHROPIC_MODEL
      } else process.env.ANTHROPIC_MODEL = previousLegacyModel
    }
  })

  test('does not preserve or silently replace an invalid explicit model', async () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousOverride = getMainLoopModelOverride()
    const catalog = configureVexzyModelCatalog(
      createVexzyModelClient({
        apiKey: 'forge-test-key',
        fetch: async () =>
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: 'available-leader',
                  object: 'model',
                  owned_by: 'vexzy',
                  display_name: 'Available Leader',
                  available: true,
                  context_length: 1_000_000,
                  supported_reasoning_efforts: ['medium'],
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                  capabilities: {
                    reasoning: true,
                    tools: true,
                    vision: false,
                  },
                },
                {
                  id: 'unavailable-leader',
                  object: 'model',
                  owned_by: 'vexzy',
                  display_name: 'Unavailable Leader',
                  available: false,
                  context_length: 1_000_000,
                  supported_reasoning_efforts: ['medium'],
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                  capabilities: {
                    reasoning: true,
                    tools: true,
                    vision: false,
                  },
                },
              ],
            }),
          ),
      }),
    )

    try {
      await catalog.load()
      setMainLoopModelOverride(undefined)
      process.env.MINDCODE_MODEL = 'missing-leader'
      expect(() => getUserSpecifiedModelSetting()).toThrow(
        /selected model.*absent from the ready VEXZY catalog/,
      )

      process.env.MINDCODE_MODEL = 'unavailable-leader'
      expect(() => getUserSpecifiedModelSetting()).toThrow(
        /selected model.*unavailable/,
      )
    } finally {
      resetVexzyModelCatalog()
      setMainLoopModelOverride(previousOverride)
      if (previousModel === undefined) {
        // biome-ignore lint/performance/noDelete: restore the exact process environment state
        delete process.env.MINDCODE_MODEL
      } else process.env.MINDCODE_MODEL = previousModel
    }
  })

  test('rejects an explicit model while the VEXZY catalog is not ready', () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousOverride = getMainLoopModelOverride()

    try {
      resetVexzyModelCatalog()
      setMainLoopModelOverride(undefined)
      process.env.MINDCODE_MODEL = 'opaque-leader:v2'

      expect(() => getUserSpecifiedModelSetting()).toThrow(
        /catalog is not ready/,
      )
    } finally {
      setMainLoopModelOverride(previousOverride)
      if (previousModel === undefined) {
        // biome-ignore lint/performance/noDelete: restore the exact process environment state
        delete process.env.MINDCODE_MODEL
      } else process.env.MINDCODE_MODEL = previousModel
    }
  })

  test('uses provider catalog order for Leader default, not the Worker model', async () => {
    const catalog = configureVexzyModelCatalog(
      createVexzyModelClient({
        apiKey: 'forge-test-key',
        fetch: async () =>
          new Response(
            JSON.stringify({
              object: 'list',
              data: [
                {
                  id: 'dynamic-leader',
                  object: 'model',
                  owned_by: 'vexzy',
                  display_name: 'Dynamic Leader',
                  available: true,
                  context_length: 1_000_000,
                  supported_reasoning_efforts: ['low', 'medium', 'high'],
                  input_modalities: ['text'],
                  output_modalities: ['text'],
                  capabilities: {
                    reasoning: true,
                    tools: true,
                    vision: false,
                  },
                },
                {
                  id: 'gpt-5.6-luna',
                  object: 'model',
                  owned_by: 'vexzy',
                  display_name: 'GPT-5.6 Luna',
                  available: true,
                  context_length: 1_050_000,
                  supported_reasoning_efforts: [
                    'none',
                    'low',
                    'medium',
                    'high',
                    'xhigh',
                    'max',
                  ],
                  input_modalities: ['text', 'image'],
                  output_modalities: ['text'],
                  capabilities: {
                    reasoning: true,
                    tools: true,
                    vision: true,
                  },
                },
              ],
            }),
          ),
      }),
    )

    try {
      await catalog.load()
      expect(getDefaultMainLoopModel()).toBe('dynamic-leader')
    } finally {
      resetVexzyModelCatalog()
    }
  })
})
