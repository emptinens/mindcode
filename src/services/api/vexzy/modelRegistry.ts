import { z } from 'zod'

export const VEXZY_FIXED_WORKER_MODEL = 'gpt-5.6-luna' as const
export const VEXZY_WORKER_MODEL = VEXZY_FIXED_WORKER_MODEL

const positiveSafeInteger = z.number().int().positive().safe()
const stringList = z.array(z.string())

export const vexzyCapabilitiesSchema = z
  .object({
    reasoning: z.boolean(),
    tools: z.boolean(),
    vision: z.boolean(),
  })
  .passthrough()

export const vexzyProviderModelSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal('model'),
    owned_by: z.literal('vexzy'),
    display_name: z.string(),
    available: z.boolean(),
    // The provider currently emits "maintenance", but preserving unknown
    // future values is safer than manufacturing local status semantics.
    status: z.string().min(1).optional(),
    context_length: positiveSafeInteger,
    supported_reasoning_efforts: stringList,
    input_modalities: stringList,
    output_modalities: stringList,
    capabilities: vexzyCapabilitiesSchema,
    // These fields are deliberately parsed as unknown. VEXZY may add or
    // change optional limit fields; invalid values must be ignored without
    // discarding the complete model catalog.
    max_output_tokens: z.unknown().optional(),
    max_completion_tokens: z.unknown().optional(),
    output_limit: z.unknown().optional(),
    max_output: z.unknown().optional(),
  })
  .passthrough()

export const vexzyModelsEnvelopeSchema = z
  .object({
    object: z.literal('list'),
    data: z.array(vexzyProviderModelSchema),
  })
  .passthrough()

export type VexzyCapabilities = z.infer<typeof vexzyCapabilitiesSchema>
export type VexzyProviderModel = z.infer<typeof vexzyProviderModelSchema>
export type VexzyModelsEnvelope = z.infer<typeof vexzyModelsEnvelopeSchema>

export function parseVexzyModelEnvelope(input: unknown): VexzyModelsEnvelope {
  return vexzyModelsEnvelopeSchema.parse(input)
}

export type VexzyModelAvailability = 'available' | 'unavailable'

export interface VexzyModel {
  readonly id: string
  readonly object: 'model'
  readonly ownedBy: 'vexzy'
  readonly displayName: string
  readonly available: boolean
  /** Exact provider status. Undefined when the provider omitted the field. */
  readonly status: string | undefined
  /** Normalized only from the provider's independent `available` boolean. */
  readonly availability: VexzyModelAvailability
  readonly context: number
  readonly contextLength: number
  readonly modalities: {
    readonly input: readonly string[]
    readonly output: readonly string[]
  }
  readonly inputModalities: readonly string[]
  readonly outputModalities: readonly string[]
  readonly reasoning: boolean
  readonly reasoningEfforts: readonly string[]
  readonly supportedReasoningEfforts: readonly string[]
  readonly tools: boolean
  readonly vision: boolean
  readonly capabilities: VexzyCapabilities
  readonly outputLimit: number | undefined
  /** Output price in VEXZY credits per 1M response tokens. */
  readonly outputCreditsPerMillion: number | null
  readonly raw: VexzyProviderModel
}

function readNonNegativeNumber(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

function readOutputCreditsPerMillion(model: VexzyProviderModel): number | null {
  const record = model as unknown as Record<string, unknown>
  const sources: unknown[] = [
    record,
    record.pricing,
    record.prices,
    record.credits,
    record.cost,
    record.price,
  ]
  const keys = [
    'output_credits_per_million',
    'outputCreditsPerMillion',
    'output_credits_per_1m_tokens',
    'output_price_credits_per_million',
    'output_credits',
    'output_per_million',
    'output_price',
    'output',
    'completion_credits_per_million',
    'completionPriceCreditsPerMillion',
  ]
  for (const source of sources) {
    if (source === null || typeof source !== 'object') continue
    const sourceRecord = source as Record<string, unknown>
    for (const key of keys) {
      const price = readNonNegativeNumber(sourceRecord[key])
      if (price !== null) return price
    }
  }
  return null
}

/**
 * VEXZY public price snapshot supplied for this MindCode release. The live
 * `/v1/models` payload is authoritative when it starts exposing a price; this
 * table is the exact-ID fallback while the endpoint omits billing fields.
 */
export const VEXZY_OUTPUT_CREDITS_PER_MILLION = {
  'qwen-3.6-plus': 152,
  'kimi-k2.6': 196,
  'minimax-m2.5': 152,
  'minimax-m2.7': 152,
  'glm-5.1': 239,
  'deepseek-v3.1': 87,
  'qwen-3.7-plus': 359,
  'kimi-k2.7-code': 239,
  'minimax-m3': 152,
  'glm-5.2': 272,
  'deepseek-v4-flash': 87,
  'deepseek-v4-pro': 152,
  'gemini-2.5-pro': 304,
  'gemini-2.5-flash': 76,
  'gpt-5.5': 587,
  'gpt-5.5-pro': 869,
  'gpt-5.6-luna': 37,
  'gpt-5.6-terra': 365,
  'gpt-5.6-sol': 631,
  'gemini-3.5-flash': 272,
  'gemini-3.6-flash': 228,
  'gemini-3.1-pro-preview': 359,
  'gemini-3.5-flash-lite': 54,
  'claude-sonnet-4-6': 456,
  'claude-sonnet-5': 304,
  'claude-opus-4-6': 750,
  'claude-opus-4-7': 750,
  'claude-opus-4-8': 750,
  'claude-opus-5': 684,
  'claude-fable-5': 608,
  'kimi-k3': 494,
  'grok-4.5': 435,
  'grok-build-0.1': 250,
} as const satisfies Readonly<Record<string, number>>

function getStaticOutputCreditsPerMillion(id: string): number | null {
  return Object.prototype.hasOwnProperty.call(
    VEXZY_OUTPUT_CREDITS_PER_MILLION,
    id,
  )
    ? VEXZY_OUTPUT_CREDITS_PER_MILLION[
        id as keyof typeof VEXZY_OUTPUT_CREDITS_PER_MILLION
      ]
    : null
}

export const VEXZY_OUTPUT_LIMIT_OVERRIDES = {
  'gpt-5.6-luna': 128_000,
  'gpt-5.6-terra': 128_000,
  'gpt-5.6-sol': 128_000,
  'claude-sonnet-5': 128_000,
  'claude-opus-4-8': 128_000,
  'claude-opus-5': 128_000,
  'kimi-k3': 131_100,
  'deepseek-v4-flash': 384_000,
  'glm-5.2': 131_100,
} as const satisfies Readonly<Record<string, number>>

export function getVexzyStaticOutputLimit(id: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(VEXZY_OUTPUT_LIMIT_OVERRIDES, id)) {
    return undefined
  }

  return VEXZY_OUTPUT_LIMIT_OVERRIDES[
    id as keyof typeof VEXZY_OUTPUT_LIMIT_OVERRIDES
  ]
}

export function isValidVexzyOutputLimit(
  value: unknown,
  contextLength: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= contextLength
  )
}

export function getVexzyDynamicOutputLimit(
  model: VexzyProviderModel,
): number | undefined {
  const candidates = [
    model.max_output_tokens,
    model.max_completion_tokens,
    model.output_limit,
    model.max_output,
  ]
  return candidates.find(candidate =>
    isValidVexzyOutputLimit(candidate, model.context_length),
  ) as number | undefined
}

export function normalizeVexzyModel(model: VexzyProviderModel): VexzyModel {
  const dynamicOutputLimit = getVexzyDynamicOutputLimit(model)

  return {
    id: model.id,
    object: model.object,
    ownedBy: model.owned_by,
    displayName: model.display_name,
    available: model.available,
    status: model.status,
    availability: model.available ? 'available' : 'unavailable',
    context: model.context_length,
    contextLength: model.context_length,
    modalities: {
      input: model.input_modalities,
      output: model.output_modalities,
    },
    inputModalities: model.input_modalities,
    outputModalities: model.output_modalities,
    reasoning: model.capabilities.reasoning,
    reasoningEfforts: model.supported_reasoning_efforts,
    supportedReasoningEfforts: model.supported_reasoning_efforts,
    tools: model.capabilities.tools,
    vision: model.capabilities.vision,
    capabilities: model.capabilities,
    outputLimit:
      dynamicOutputLimit ??
      (() => {
        const fallback = getVexzyStaticOutputLimit(model.id)
        return fallback !== undefined &&
          isValidVexzyOutputLimit(fallback, model.context_length)
          ? fallback
          : undefined
      })(),
    outputCreditsPerMillion:
      readOutputCreditsPerMillion(model) ??
      getStaticOutputCreditsPerMillion(model.id),
    raw: model,
  }
}

export function parseVexzyModels(input: unknown): VexzyModel[] {
  const envelope = parseVexzyModelEnvelope(input)
  const ids = new Set<string>()
  const models: VexzyModel[] = []

  for (const providerModel of envelope.data) {
    if (ids.has(providerModel.id)) {
      throw new Error(`Duplicate Vexzy provider model ID: ${providerModel.id}`)
    }
    ids.add(providerModel.id)
    models.push(normalizeVexzyModel(providerModel))
  }

  return models
}

export interface VexzyModelRegistry {
  readonly envelope: VexzyModelsEnvelope
  readonly models: readonly VexzyModel[]
  readonly byId: ReadonlyMap<string, VexzyModel>
  get(id: string): VexzyModel | undefined
  has(id: string): boolean
}

export function createVexzyModelRegistry(input: unknown): VexzyModelRegistry {
  const envelope = parseVexzyModelEnvelope(input)
  const models = parseVexzyModels(envelope)
  const byId = new Map(models.map(model => [model.id, model]))

  return {
    envelope,
    models,
    byId,
    get: id => byId.get(id),
    has: id => byId.has(id),
  }
}

export function getVexzyModel(
  registry: VexzyModelRegistry,
  providerId: string,
): VexzyModel | undefined {
  return registry.get(providerId)
}

export function getVexzyWorkerModel(
  registry: VexzyModelRegistry,
): VexzyModel | undefined {
  return registry.get(VEXZY_FIXED_WORKER_MODEL)
}
