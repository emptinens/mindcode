import { z } from 'zod'

export const VEXZY_FIXED_WORKER_MODEL = 'gpt-5.6-luna' as const
export const VEXZY_WORKER_MODEL = VEXZY_FIXED_WORKER_MODEL

const nonNegativeInteger = z.number().int().nonnegative()
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
    context_length: nonNegativeInteger,
    supported_reasoning_efforts: stringList,
    input_modalities: stringList,
    output_modalities: stringList,
    capabilities: vexzyCapabilitiesSchema,
    max_output_tokens: nonNegativeInteger.optional(),
    max_completion_tokens: nonNegativeInteger.optional(),
    output_limit: nonNegativeInteger.optional(),
    max_output: nonNegativeInteger.optional(),
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
  readonly raw: VexzyProviderModel
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

function getStaticOutputLimit(id: string): number | undefined {
  if (!Object.prototype.hasOwnProperty.call(VEXZY_OUTPUT_LIMIT_OVERRIDES, id)) {
    return undefined
  }

  return VEXZY_OUTPUT_LIMIT_OVERRIDES[
    id as keyof typeof VEXZY_OUTPUT_LIMIT_OVERRIDES
  ]
}

function getDynamicOutputLimit(model: VexzyProviderModel): number | undefined {
  return (
    model.max_output_tokens ??
    model.max_completion_tokens ??
    model.output_limit ??
    model.max_output
  )
}

export function normalizeVexzyModel(model: VexzyProviderModel): VexzyModel {
  const dynamicOutputLimit = getDynamicOutputLimit(model)

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
    outputLimit: dynamicOutputLimit ?? getStaticOutputLimit(model.id),
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
