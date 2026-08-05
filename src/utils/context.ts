import { CONTEXT_1M_BETA_HEADER } from '../constants/betas.js'
import { getVexzyModelCatalogState } from '../services/api/vexzy/modelCatalog.js'
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
  if (
    !Number.isSafeInteger(catalogModel.contextLength) ||
    catalogModel.contextLength <= 0 ||
    !Number.isSafeInteger(catalogModel.outputLimit) ||
    catalogModel.outputLimit <= 0
  ) {
    throw new Error(`Vexzy model '${modelId}' has invalid runtime limits`)
  }
  return {
    contextLength: catalogModel.contextLength,
    outputLimit: catalogModel.outputLimit,
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
  const outputLimit = requireVexzyModelLimits(model).outputLimit
  return { default: outputLimit, upperLimit: outputLimit }
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
