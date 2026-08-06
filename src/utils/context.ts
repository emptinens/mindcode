import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getVexzyModelCatalogState } from '../services/api/vexzy/modelCatalog.js'
import {
  getVexzyStaticOutputLimit,
  isValidVexzyOutputLimit,
} from '../services/api/vexzy/modelRegistry.js'
import { isEnvTruthy } from './envUtils.js'

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000
const MAX_OUTPUT_TOKENS_DEFAULT = 32_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 64_000
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000
export const ESCALATED_MAX_TOKENS = 64_000

export function is1mContextDisabled(): boolean {
  return isEnvTruthy(process.env.MINDCODE_DISABLE_1M_CONTEXT)
}

function stripContextSuffix(model: string): string {
  return model.replace(/\[(?:1|2)m\]$/i, '')
}

export type VexzyOutputTokenPolicy = {
  readonly contextLength: number
  readonly maxOutputTokens: number
}

export type VexzyMaxOutputTokensNormalization = {
  readonly value: number
  readonly status: 'valid' | 'clamped' | 'fallback'
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/** Resolve the output-token ceiling shared by runtime, SDK, and transport. */
export function getVexzyOutputTokenPolicy(
  model: string,
): VexzyOutputTokenPolicy {
  const modelId = stripContextSuffix(model)
  const state = getVexzyModelCatalogState()

  // A static limit is usable only while the dynamic catalog is cold or
  // unavailable. Once a catalog is ready, its exact model IDs are
  // authoritative: a model missing from it must fail closed, even if a
  // legacy static limit exists for that ID.
  if (state.state !== 'ready') {
    const staticLimit = getVexzyStaticOutputLimit(modelId)
    if (staticLimit !== undefined) {
      return {
        contextLength: staticLimit,
        maxOutputTokens: staticLimit,
      }
    }
    throw new Error(`Vexzy model catalog is not ready (state: ${state.state})`)
  }

  const entry = state.registry?.get(modelId)
  if (entry === undefined) {
    throw new Error(`Vexzy model '${modelId}' is not in the dynamic catalog`)
  }

  if (!entry.available) {
    throw new Error(`Vexzy model '${modelId}' is unavailable`)
  }

  const staticLimit = getVexzyStaticOutputLimit(modelId)
  const dynamicLimit = isValidVexzyOutputLimit(
    entry.outputLimit,
    entry.contextLength,
  )
    ? entry.outputLimit
    : undefined
  const staticFallback =
    staticLimit !== undefined &&
    isValidVexzyOutputLimit(staticLimit, entry.contextLength)
      ? staticLimit
      : undefined
  const maxOutputTokens = dynamicLimit ?? staticFallback
  if (maxOutputTokens === undefined) {
    throw new Error(
      `Vexzy model '${modelId}' has no confirmed output token limit`,
    )
  }
  return { contextLength: entry.contextLength, maxOutputTokens }
}

export function normalizeVexzyMaxOutputTokens(
  requested: unknown,
  fallback: number,
  upperLimit: number,
  rejectInvalid = false,
): VexzyMaxOutputTokensNormalization {
  if (!isPositiveSafeInteger(upperLimit)) {
    throw new RangeError(
      'output token upper limit must be a positive safe integer',
    )
  }
  const validFallback = isPositiveSafeInteger(fallback)
    ? Math.min(fallback, upperLimit)
    : upperLimit
  if (!isPositiveSafeInteger(requested)) {
    if (rejectInvalid) {
      throw new RangeError('max_tokens must be a positive safe integer')
    }
    return { value: validFallback, status: 'fallback' }
  }
  return requested > upperLimit
    ? { value: upperLimit, status: 'clamped' }
    : { value: requested, status: 'valid' }
}

/** Parse the string-only environment boundary before applying the policy. */
export function normalizeVexzyMaxOutputTokensEnv(
  requested: string | undefined,
  fallback: number,
  upperLimit: number,
): VexzyMaxOutputTokensNormalization {
  const normalized = requested?.trim()
  if (!normalized || !/^\d+$/.test(normalized)) {
    return normalizeVexzyMaxOutputTokens(undefined, fallback, upperLimit)
  }
  return normalizeVexzyMaxOutputTokens(
    Number(normalized),
    fallback,
    upperLimit,
  )
}

export function getVexzyMaxOutputTokens(
  model: string,
  requested: unknown,
  fallback: number,
  rejectInvalid = false,
): number {
  const policy = getVexzyOutputTokenPolicy(model)
  return normalizeVexzyMaxOutputTokens(
    requested,
    fallback,
    policy.maxOutputTokens,
    rejectInvalid,
  ).value
}

function requireVexzyModelLimits(model: string): {
  contextLength: number
  outputLimit: number
} {
  const state = getVexzyModelCatalogState()
  if (state.state !== 'ready' || state.registry === undefined) {
    throw new Error(`Vexzy model catalog is not ready (state: ${state.state})`)
  }

  const modelId = stripContextSuffix(model)
  const catalogModel = state.registry.get(modelId)
  if (catalogModel === undefined) {
    throw new Error(`Vexzy model '${modelId}' is not in the dynamic catalog`)
  }
  if (!catalogModel.available) {
    throw new Error(`Vexzy model '${modelId}' is unavailable`)
  }
  const staticLimit = getVexzyStaticOutputLimit(modelId)
  const outputLimit =
    catalogModel.outputLimit ??
    (staticLimit !== undefined &&
    isValidVexzyOutputLimit(staticLimit, catalogModel.contextLength)
      ? staticLimit
      : undefined)
  if (
    !Number.isSafeInteger(catalogModel.contextLength) ||
    catalogModel.contextLength <= 0 ||
    typeof outputLimit !== 'number' ||
    !Number.isSafeInteger(outputLimit) ||
    outputLimit <= 0 ||
    outputLimit > catalogModel.contextLength
  ) {
    throw new Error(`Vexzy model '${modelId}' has invalid runtime limits`)
  }
  return {
    contextLength: catalogModel.contextLength,
    outputLimit,
  }
}

export function has1mContext(model: string): boolean {
  return /\[1m\]/i.test(model) && !is1mContextDisabled()
}

export function modelSupports1M(model: string): boolean {
  return requireVexzyModelLimits(model).contextLength >= 1_000_000
}

export function getContextWindowForModel(
  model: string,
  _betas?: string[],
): number {
  return requireVexzyModelLimits(model).contextLength
}

export function getSonnet1mExpTreatmentEnabled(_model: string): boolean {
  return false
}

export function calculateContextPercentages(
  currentUsage: {
    input_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  } | null,
  contextWindowSize: number,
): { used: number | null; remaining: number | null } {
  if (!currentUsage) return { used: null, remaining: null }

  const totalInputTokens =
    currentUsage.input_tokens +
    currentUsage.cache_creation_input_tokens +
    currentUsage.cache_read_input_tokens
  const usedPercentage = Math.round(
    (totalInputTokens / contextWindowSize) * 100,
  )
  const clampedUsed = Math.min(100, Math.max(0, usedPercentage))
  return { used: clampedUsed, remaining: 100 - clampedUsed }
}

export function getModelMaxOutputTokens(model: string): {
  default: number
  upperLimit: number
} {
  const policy = getVexzyOutputTokenPolicy(model)
  return {
    default: policy.maxOutputTokens,
    upperLimit: policy.maxOutputTokens,
  }
}

export function getMaxThinkingTokensForModel(model: string): number {
  return getModelMaxOutputTokens(model).upperLimit - 1
}

// Keep these constants referenced so external callers importing them retain a
// stable local fallback contract; all runtime VEXZY paths use catalog limits.
export const __LOCAL_CONTEXT_DEFAULTS = {
  defaultOutput: MAX_OUTPUT_TOKENS_DEFAULT,
  upperOutput: MAX_OUTPUT_TOKENS_UPPER_LIMIT,
  defaultContext: MODEL_CONTEXT_WINDOW_DEFAULT,
  compactOutput: COMPACT_MAX_OUTPUT_TOKENS,
  cappedOutput: CAPPED_DEFAULT_MAX_TOKENS,
  escalatedOutput: ESCALATED_MAX_TOKENS,
  contextBeta: CONTEXT_1M_BETA_HEADER,
} as const
