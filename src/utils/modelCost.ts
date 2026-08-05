import type { BetaUsage as Usage } from 'src/services/api/vexzy/protocolTypes.js'
import { logEvent } from 'src/services/analytics/index.js'
import { setHasUnknownModelCost } from '../bootstrap/state.js'
import type { ModelShortName } from './model/model.js'

export type ModelCosts = {
  inputTokens: number
  outputTokens: number
  promptCacheWriteTokens: number
  promptCacheReadTokens: number
  webSearchRequests: number
}

/** Local neutral estimate used when VEXZY does not publish price metadata. */
export const COST_TIER_3_15 = {
  inputTokens: 3,
  outputTokens: 15,
  promptCacheWriteTokens: 3.75,
  promptCacheReadTokens: 0.3,
  webSearchRequests: 0.01,
} as const satisfies ModelCosts

export const COST_TIER_15_75 = COST_TIER_3_15
export const COST_TIER_5_25 = COST_TIER_3_15
export const COST_TIER_30_150 = COST_TIER_3_15
export const COST_HAIKU_35 = COST_TIER_3_15
export const COST_HAIKU_45 = COST_TIER_3_15

const DEFAULT_UNKNOWN_MODEL_COST = COST_TIER_3_15

export function getOpus48CostTier(_fastMode: boolean): ModelCosts {
  return DEFAULT_UNKNOWN_MODEL_COST
}

/**
 * No model IDs are compiled into the cost table. VEXZY model IDs remain
 * opaque, and price metadata can be added to the catalog without changing
 * this resolver.
 */
export const MODEL_COSTS: Record<ModelShortName, ModelCosts> = {}

function tokensToUSDCost(modelCosts: ModelCosts, usage: Usage): number {
  return (
    (usage.input_tokens / 1_000_000) * modelCosts.inputTokens +
    (usage.output_tokens / 1_000_000) * modelCosts.outputTokens +
    ((usage.cache_read_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheReadTokens +
    ((usage.cache_creation_input_tokens ?? 0) / 1_000_000) *
      modelCosts.promptCacheWriteTokens +
    (usage.server_tool_use?.web_search_requests ?? 0) *
      modelCosts.webSearchRequests
  )
}

export function getModelCosts(_model: string, _usage: Usage): ModelCosts {
  return DEFAULT_UNKNOWN_MODEL_COST
}

function trackUnknownModelCost(model: string): void {
  logEvent('tengu_unknown_model_cost', { model })
  setHasUnknownModelCost()
}

export function calculateUSDCost(resolvedModel: string, usage: Usage): number {
  if (!MODEL_COSTS[resolvedModel]) trackUnknownModelCost(resolvedModel)
  return tokensToUSDCost(getModelCosts(resolvedModel, usage), usage)
}

export function calculateCostFromTokens(
  model: string,
  tokens: {
    inputTokens: number
    outputTokens: number
    cacheReadInputTokens: number
    cacheCreationInputTokens: number
  },
): number {
  return calculateUSDCost(model, {
    input_tokens: tokens.inputTokens,
    output_tokens: tokens.outputTokens,
    cache_read_input_tokens: tokens.cacheReadInputTokens,
    cache_creation_input_tokens: tokens.cacheCreationInputTokens,
  } as Usage)
}

function formatPrice(price: number): string {
  return Number.isInteger(price) ? `$${price}` : `$${price.toFixed(2)}`
}

export function formatModelPricing(costs: ModelCosts): string {
  return `${formatPrice(costs.inputTokens)}/${formatPrice(costs.outputTokens)} per Mtok`
}

export function getModelPricingString(_model: string): string | undefined {
  return undefined
}
