import { describe, expect, test } from 'bun:test'
import {
  VEXZY_FIXED_WORKER_MODEL,
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

describe('Vexzy model registry', () => {
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
