import {
  VEXZY_API_KEY_ENV,
  VEXZY_MESSAGES_BASE_URL,
  requireVexzyApiKey,
} from '../../services/api/vexzy/config.js'

export const VEXZY_PROVIDER = 'vexzy' as const

export const VEXZY_PROVIDER_POLICY = Object.freeze({
  provider: VEXZY_PROVIDER,
  apiKeyEnv: VEXZY_API_KEY_ENV,
  apiKeyPrefix: 'forge-',
  messagesBaseUrl: VEXZY_MESSAGES_BASE_URL,
})

export type VexzyProviderPolicy = typeof VEXZY_PROVIDER_POLICY

/**
 * Resolve the only runtime provider. Missing or malformed credentials throw;
 * there is intentionally no provider fallback.
 */
export function resolveVexzyProvider(
  env: Record<string, string | undefined> = process.env,
) {
  return {
    ...VEXZY_PROVIDER_POLICY,
    apiKey: requireVexzyApiKey(env),
  } as const
}
