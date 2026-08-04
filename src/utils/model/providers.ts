import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import {
  VEXZY_API_KEY_ENV,
  VEXZY_MESSAGES_BASE_URL,
  requireVexzyApiKey,
} from '../../services/api/vexzy/config.js'
import { isEnvTruthy } from '../envUtils.js'

export const VEXZY_BASE_URL = VEXZY_MESSAGES_BASE_URL

export function getVexzyRuntimeApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env[VEXZY_API_KEY_ENV] === undefined) return undefined
  return requireVexzyApiKey(env)
}

export function isVexzyMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return getVexzyRuntimeApiKey(env) !== undefined
}

export type APIProvider = 'firstParty' | 'bedrock' | 'vertex' | 'foundry'

export function getAPIProvider(): APIProvider {
  if (isVexzyMode()) return 'firstParty'

  return isEnvTruthy(process.env.CLAUDE_CODE_USE_BEDROCK)
    ? 'bedrock'
    : isEnvTruthy(process.env.CLAUDE_CODE_USE_VERTEX)
      ? 'vertex'
      : isEnvTruthy(process.env.CLAUDE_CODE_USE_FOUNDRY)
        ? 'foundry'
        : 'firstParty'
}

export function getAPIProviderForStatsig(): AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS {
  return getAPIProvider() as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS
}

/**
 * Check if ANTHROPIC_BASE_URL is a first-party Anthropic API URL.
 * Returns true if not set (default API) or points to api.anthropic.com
 * (or api-staging.anthropic.com for ant users).
 */
export function isFirstPartyAnthropicBaseUrl(): boolean {
  const baseUrl = process.env.ANTHROPIC_BASE_URL
  if (!baseUrl) {
    return true
  }
  try {
    const host = new URL(baseUrl).host
    const allowedHosts = ['api.anthropic.com']
    if (process.env.USER_TYPE === 'ant') {
      allowedHosts.push('api-staging.anthropic.com')
    }
    return allowedHosts.includes(host)
  } catch {
    return false
  }
}
