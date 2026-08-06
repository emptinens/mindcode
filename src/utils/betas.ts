import { feature } from 'bun:bundle'
import memoize from 'lodash-es/memoize.js'
import {
  checkStatsigFeatureGate_CACHED_MAY_BE_STALE,
  getFeatureValue_CACHED_MAY_BE_STALE,
} from 'src/services/analytics/growthbook.js'
import { getIsNonInteractiveSession, getSdkBetas } from '../bootstrap/state.js'
import {
  CONTEXT_1M_BETA_HEADER,
  CONTEXT_MANAGEMENT_BETA_HEADER,
  EFFORT_BETA_HEADER,
  INTERLEAVED_THINKING_BETA_HEADER,
  MINDCODE_20250219_BETA_HEADER,
  PROMPT_CACHING_SCOPE_BETA_HEADER,
  REDACT_THINKING_BETA_HEADER,
  STRUCTURED_OUTPUTS_BETA_HEADER,
  SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER,
  TOKEN_EFFICIENT_TOOLS_BETA_HEADER,
  TOOL_SEARCH_BETA_HEADER_1P,
} from '../constants/betas.js'
import { has1mContext } from './context.js'
import { isEnvDefinedFalsy, isEnvTruthy } from './envUtils.js'
import { getVexzyModelCatalogState } from '../services/api/vexzy/modelCatalog.js'
import { getInitialSettings } from './settings/settings.js'

const ALLOWED_SDK_BETAS = [CONTEXT_1M_BETA_HEADER]

function getCatalogModel(model: string) {
  return getVexzyModelCatalogState().registry?.get(model)
}

export function filterAllowedSdkBetas(
  sdkBetas: string[] | undefined,
): string[] | undefined {
  if (!sdkBetas || sdkBetas.length === 0) return undefined

  const allowed: string[] = []
  for (const beta of sdkBetas) {
    if (ALLOWED_SDK_BETAS.includes(beta)) allowed.push(beta)
    else console.warn(`Warning: Beta header '${beta}' is not allowed.`)
  }
  return allowed.length > 0 ? allowed : undefined
}

/** VEXZY advertises capabilities in its dynamic model catalog. */
export function modelSupportsISP(model: string): boolean {
  return getCatalogModel(model)?.available === true
}

export function modelSupportsContextManagement(model: string): boolean {
  return getCatalogModel(model)?.available === true
}

export function modelSupportsStructuredOutputs(model: string): boolean {
  const entry = getCatalogModel(model)
  return entry?.available === true && entry.capabilities.tools
}

export function modelSupportsAutoMode(model: string): boolean {
  if (!feature('TRANSCRIPT_CLASSIFIER')) return false
  const entry = getCatalogModel(model)
  if (entry?.available !== true || !entry.reasoning) return false

  const config = getFeatureValue_CACHED_MAY_BE_STALE<{
    allowModels?: string[]
  }>('tengu_auto_mode_config', {})
  return (
    config.allowModels?.some(id => id === model) === true ||
    entry.supportedReasoningEfforts.includes('auto')
  )
}

/** VEXZY uses one Messages-compatible tool-search header. */
export function getToolSearchBetaHeader(): string {
  return TOOL_SEARCH_BETA_HEADER_1P
}

/** Compatibility name retained for callers; the VEXZY runtime accepts these betas. */
export function shouldIncludeFirstPartyOnlyBetas(): boolean {
  return !isEnvTruthy(process.env.MINDCODE_DISABLE_EXPERIMENTAL_BETAS)
}

/** Global cache scope is not inferred locally; VEXZY owns cache policy. */
export function shouldUseGlobalCacheScope(): boolean {
  return false
}

export const getAllModelBetas = memoize((model: string): string[] => {
  const betaHeaders: string[] = [MINDCODE_20250219_BETA_HEADER]

  if (has1mContext(model)) betaHeaders.push(CONTEXT_1M_BETA_HEADER)
  if (!isEnvTruthy(process.env.DISABLE_INTERLEAVED_THINKING)) {
    betaHeaders.push(INTERLEAVED_THINKING_BETA_HEADER)
  }

  const includeExperimental = shouldIncludeFirstPartyOnlyBetas()
  if (
    includeExperimental &&
    !getIsNonInteractiveSession() &&
    getInitialSettings().showThinkingSummaries !== true
  ) {
    betaHeaders.push(REDACT_THINKING_BETA_HEADER)
  }

  if (
    SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER &&
    !isEnvDefinedFalsy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) &&
    (isEnvTruthy(process.env.USE_CONNECTOR_TEXT_SUMMARIZATION) ||
      getFeatureValue_CACHED_MAY_BE_STALE('tengu_slate_prism', false))
  ) {
    betaHeaders.push(SUMMARIZE_CONNECTOR_TEXT_BETA_HEADER)
  }

  if (
    includeExperimental &&
    (isEnvTruthy(process.env.USE_API_CONTEXT_MANAGEMENT) ||
      modelSupportsContextManagement(model))
  ) {
    betaHeaders.push(CONTEXT_MANAGEMENT_BETA_HEADER)
  }

  const strictToolsEnabled = checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
    'tengu_tool_pear',
  )
  if (
    includeExperimental &&
    modelSupportsStructuredOutputs(model) &&
    strictToolsEnabled
  ) {
    betaHeaders.push(STRUCTURED_OUTPUTS_BETA_HEADER)
  }

  if (
    includeExperimental &&
    !strictToolsEnabled &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_amber_json_tools', false)
  ) {
    betaHeaders.push(TOKEN_EFFICIENT_TOOLS_BETA_HEADER)
  }

  if (includeExperimental) {
    betaHeaders.push(PROMPT_CACHING_SCOPE_BETA_HEADER)
  }
  if (EFFORT_BETA_HEADER) betaHeaders.push(EFFORT_BETA_HEADER)

  if (process.env.VEXZY_BETAS) {
    betaHeaders.push(
      ...process.env.VEXZY_BETAS.split(',')
        .map(value => value.trim())
        .filter(Boolean),
    )
  }

  return [...new Set(betaHeaders)]
})

export const getModelBetas = memoize((model: string): string[] =>
  getAllModelBetas(model),
)

export function getMergedBetas(
  model: string,
  options?: { isAgenticQuery?: boolean },
): string[] {
  const baseBetas = [...getModelBetas(model)]
  if (
    options?.isAgenticQuery &&
    !baseBetas.includes(MINDCODE_20250219_BETA_HEADER)
  ) {
    baseBetas.push(MINDCODE_20250219_BETA_HEADER)
  }
  const sdkBetas = getSdkBetas()
  if (!sdkBetas || sdkBetas.length === 0) return baseBetas
  return [...baseBetas, ...sdkBetas.filter(beta => !baseBetas.includes(beta))]
}

export function clearBetasCaches(): void {
  getAllModelBetas.cache?.clear?.()
  getModelBetas.cache?.clear?.()
}
