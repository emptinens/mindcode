import { describe, expect, test } from 'bun:test'
import suppliedModels from './fixtures/models-supplied.json' with { type: 'json' }
import {
  VEXZY_FIXED_WORKER_MODEL,
  VEXZY_OUTPUT_CREDITS_PER_MILLION,
  VEXZY_OUTPUT_LIMIT_OVERRIDES,
  createVexzyModelRegistry,
  getVexzyModel,
  getVexzyWorkerModel,
  parseVexzyModels,
  vexzyModelsEnvelopeSchema,
} from './modelRegistry.js'

const liveLuna = {
  id: 'gpt-5.6-luna',
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: 'GPT-5.6 Luna',
  available: true,
  context_length: 1_050_000,
  supported_reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  input_modalities: ['text', 'image', 'file'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: true },
  provider_metadata: { source: 'verified-live' },
}

const liveMaintenanceOpus = {
  id: 'claude-opus-5',
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: 'Claude Opus 5',
  available: false,
  status: 'maintenance' as const,
  context_length: 1_000_000,
  supported_reasoning_efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  input_modalities: ['text', 'image', 'file'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: true },
  maintenance_metadata: { reason: 'scheduled' },
}



const suppliedModelIds = [
  'claude-fable-5',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-sonnet-4-6',
  'claude-sonnet-5',
  'deepseek-v3.1',
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3.1-pro-preview',
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'glm-5.1',
  'glm-5.2',
  'gpt-5.5',
  'gpt-5.5-pro',
  'gpt-5.6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'grok-4.5',
  'grok-build-0.1',
  'kimi-k2.6',
  'kimi-k2.7-code',
  'kimi-k3',
  'minimax-m2.5',
  'minimax-m2.7',
  'minimax-m3',
  'qwen-3.6-plus',
  'qwen-3.7-plus',
] as const

const suppliedRegistry = createVexzyModelRegistry(suppliedModels)

describe('Vexzy model registry', () => {
  test('matches all exact supplied VEXZY model IDs and provider availability', () => {
    expect(suppliedModels.data).toHaveLength(33)
    expect(suppliedModels.data.map(model => model.id)).toEqual([...suppliedModelIds])
    expect(suppliedRegistry.models.map(model => model.id)).toEqual([...suppliedModelIds])

    for (const model of suppliedModels.data) {
      const normalized = suppliedRegistry.get(model.id)
      expect(normalized).toBeDefined()
      expect(normalized?.available).toBe(model.available)
      expect(normalized?.status).toBe(model.status)
      expect(normalized?.contextLength).toBe(model.context_length)
      expect(normalized?.reasoningEfforts).toEqual(model.supported_reasoning_efforts)
      expect(normalized?.inputModalities).toEqual(model.input_modalities)
      expect(normalized?.outputModalities).toEqual(model.output_modalities)
      expect(normalized?.capabilities).toEqual(model.capabilities)
      expect(normalized?.outputCreditsPerMillion).toBeGreaterThan(0)
    }
  })

  test('covers every supplied model with the public VEXZY price snapshot', () => {
    expect(Object.keys(VEXZY_OUTPUT_CREDITS_PER_MILLION).sort()).toEqual(
      [...suppliedModelIds].sort(),
    )
    expect(suppliedRegistry.get('gpt-5.6-luna')?.outputCreditsPerMillion).toBe(37)
    expect(suppliedRegistry.get('gpt-5.6-sol')?.outputCreditsPerMillion).toBe(631)
    expect(suppliedRegistry.get('claude-fable-5')?.outputCreditsPerMillion).toBe(608)
  })

  test('keeps fixed Luna resolution and output limits from the supplied contract', () => {
    const luna = getVexzyWorkerModel(suppliedRegistry)
    expect(luna).toMatchObject({
      id: 'gpt-5.6-luna',
      available: true,
      status: 'available',
      context: 1_050_000,
      contextLength: 1_050_000,
      outputLimit: 128_000,
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
    })
    expect(luna?.raw.capabilities).toEqual({ reasoning: true, tools: true, vision: true })
    expect(getVexzyModel(suppliedRegistry, 'claude-opus-5')?.availability).toBe('unavailable')
    expect(getVexzyModel(suppliedRegistry, 'grok-build-0.1')?.reasoningEfforts).toEqual(['auto'])
  })

  test('parses the verified live Luna and maintenance Opus wire entries', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [liveLuna, liveMaintenanceOpus],
      envelope_metadata: { source: 'verified-live' },
    })
    const luna = registry.get('gpt-5.6-luna')
    const opus = registry.get('claude-opus-5')

    expect(luna).toMatchObject({
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      available: true,
      status: undefined,
      availability: 'available',
      context: 1_050_000,
      inputModalities: ['text', 'image', 'file'],
      outputModalities: ['text'],
      reasoning: true,
      reasoningEfforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
      tools: true,
      vision: true,
      outputLimit: 128_000,
    })
    expect(luna?.raw.provider_metadata).toEqual({ source: 'verified-live' })
    expect(opus).toMatchObject({
      id: 'claude-opus-5',
      available: false,
      status: 'maintenance',
      availability: 'unavailable',
      contextLength: 1_000_000,
      reasoning: true,
      tools: true,
      vision: true,
      outputLimit: 128_000,
    })
    expect(opus?.raw.maintenance_metadata).toEqual({ reason: 'scheduled' })
    expect(registry.envelope.envelope_metadata).toEqual({
      source: 'verified-live',
    })
  })

  test('preserves unknown capability and entry fields', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [
        {
          ...liveLuna,
          capabilities: {
            ...liveLuna.capabilities,
            vendor_flag: 'preserve-me',
          },
          vendor_field: { preserved: true },
        },
      ],
    })

    const model = registry.get('gpt-5.6-luna')
    expect(model?.raw.vendor_field).toEqual({ preserved: true })
    expect(model?.capabilities.vendor_flag).toBe('preserve-me')
  })

  test('preserves an unknown provider status without changing availability', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [{ ...liveLuna, status: 'provider-future-state' }],
    })

    expect(registry.get('gpt-5.6-luna')).toMatchObject({
      available: true,
      status: 'provider-future-state',
      availability: 'available',
    })
  })

  test('uses dynamic max-output fields before exact-ID fallback overrides', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [{ ...liveLuna, max_output_tokens: 999 }],
    })

    expect(registry.get('gpt-5.6-luna')?.outputLimit).toBe(999)
    expect(
      createVexzyModelRegistry({
        object: 'list',
        data: [liveMaintenanceOpus],
      }).get('claude-opus-5')?.outputLimit,
    ).toBe(128_000)
    expect(VEXZY_OUTPUT_LIMIT_OVERRIDES['gpt-5.6-luna']).toBe(128_000)
  })

  test('rejects payloads that do not match the verified wire envelope', () => {
    expect(() => vexzyModelsEnvelopeSchema.parse({ data: [] })).toThrow()
    expect(() =>
      parseVexzyModels({
        object: 'list',
        data: [{ ...liveLuna, object: 'not-model' }],
      }),
    ).toThrow()
    expect(() =>
      parseVexzyModels({
        object: 'list',
        data: [{ ...liveLuna, owned_by: 'other-provider' }],
      }),
    ).toThrow()
    expect(() =>
      parseVexzyModels({
        object: 'list',
        data: [{ ...liveLuna, capabilities: { reasoning: true } }],
      }),
    ).toThrow()
  })

  test('keeps dynamic discovery authoritative and provider IDs exact', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [liveLuna],
    })

    expect(getVexzyModel(registry, 'gpt-5.6-luna')?.id).toBe('gpt-5.6-luna')
    expect(getVexzyModel(registry, 'GPT-5.6-LUNA')).toBeUndefined()
    expect(getVexzyModel(registry, 'gpt-5.6')).toBeUndefined()
    expect(registry.get('claude-opus-5')).toBeUndefined()
    expect(getVexzyWorkerModel(registry)?.id).toBe(VEXZY_FIXED_WORKER_MODEL)
    expect(VEXZY_FIXED_WORKER_MODEL).toBe('gpt-5.6-luna')
  })

  test('rejects duplicate provider IDs', () => {
    expect(() =>
      parseVexzyModels({
        object: 'list',
        data: [liveLuna, liveLuna],
      }),
    ).toThrow('Duplicate Vexzy provider model ID')
  })
})
