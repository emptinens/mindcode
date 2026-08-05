import {
  VEXZY_API_KEY_ENV,
  requireVexzyApiKey,
} from '../../services/api/vexzy/config.js'
import {
  VEXZY_PROVIDER,
  VEXZY_PROVIDER_POLICY,
  resolveVexzyProvider,
} from './vexzyProviderPolicy.js'

export const VEXZY_BASE_URL = VEXZY_PROVIDER_POLICY.messagesBaseUrl

export function getVexzyRuntimeApiKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env[VEXZY_API_KEY_ENV] === undefined) return undefined
  return requireVexzyApiKey(env)
}

export function isVexzyMode(
  env: Record<string, string | undefined> = process.env,
): boolean {
  // MindCode has one provider mode even before login. Validate a supplied key
  // eagerly, but never expose a provider fallback.
  if (env[VEXZY_API_KEY_ENV] !== undefined) getVexzyRuntimeApiKey(env)
  return true
}

export type RuntimeAPIProvider = typeof VEXZY_PROVIDER
export type APIProvider = RuntimeAPIProvider

export function getAPIProvider(
  env: Record<string, string | undefined> = process.env,
): APIProvider {
  resolveVexzyProvider(env)
  return VEXZY_PROVIDER
}

export function getAPIProviderForStatsig(
  env: Record<string, string | undefined> = process.env,
): RuntimeAPIProvider {
  return getAPIProvider(env)
}
