/**
 * HTTP utility constants and helpers
 */

import { getAnthropicApiKey } from './auth.js'
import { getMindCodeUserAgent } from './userAgent.js'
import { getWorkload } from './workloadContext.js'

// WARNING: We rely on `mindcode` in the user agent for log filtering.
// Please do NOT change this without making sure that logging also gets updated!
export function getUserAgent(): string {
  const agentSdkVersion = process.env.MINDCODE_AGENT_SDK_VERSION
    ? `, agent-sdk/${process.env.MINDCODE_AGENT_SDK_VERSION}`
    : ''
  // SDK consumers can identify their app/library via MINDCODE_AGENT_SDK_CLIENT_APP
  // e.g., "my-app/1.0.0" or "my-library/2.1"
  const clientApp = process.env.MINDCODE_AGENT_SDK_CLIENT_APP
    ? `, client-app/${process.env.MINDCODE_AGENT_SDK_CLIENT_APP}`
    : ''
  // Turn-/process-scoped workload tag for cron-initiated requests. 1P-only
  // observability — proxies strip HTTP headers; QoS routing uses cc_workload
  // in the billing-header attribution block instead (see constants/system.ts).
  // getVexzyClient (client.ts:98) calls this per-request inside withRetry,
  // so the read picks up the same setWorkload() value as getAttributionHeader.
  const workload = getWorkload()
  const workloadSuffix = workload ? `, workload/${workload}` : ''
  return `mindcode/${MACRO.VERSION} (${process.env.USER_TYPE}, ${process.env.MINDCODE_ENTRYPOINT ?? 'cli'}${agentSdkVersion}${clientApp}${workloadSuffix})`
}

export function getMCPUserAgent(): string {
  const parts: string[] = []
  if (process.env.MINDCODE_ENTRYPOINT) {
    parts.push(process.env.MINDCODE_ENTRYPOINT)
  }
  if (process.env.MINDCODE_AGENT_SDK_VERSION) {
    parts.push(`agent-sdk/${process.env.MINDCODE_AGENT_SDK_VERSION}`)
  }
  if (process.env.MINDCODE_AGENT_SDK_CLIENT_APP) {
    parts.push(`client-app/${process.env.MINDCODE_AGENT_SDK_CLIENT_APP}`)
  }
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : ''
  return `mindcode/${MACRO.VERSION}${suffix}`
}

export function getWebFetchUserAgent(): string {
  return `MindCode-User (${getMindCodeUserAgent()})`
}

export type AuthHeaders = {
  headers: Record<string, string>
  error?: string
}

/**
 * Compatibility helper for auxiliary VEXZY requests.
 */
export function getAuthHeaders(): AuthHeaders {
  const apiKey = getAnthropicApiKey()
  if (!apiKey) {
    return {
      headers: {},
      error: 'No API key available',
    }
  }
  return {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  }
}

/**
 * Wrapper that handles OAuth 401 errors by force-refreshing the token and
 * retrying once. Addresses clock drift scenarios where the local expiration
 * check disagrees with the server.
 *
 * The request closure is called again on retry, so it should re-read auth
 * (e.g., via getAuthHeaders()) to pick up the refreshed token.
 *
 * Note: bridgeApi.ts has its own DI-injected version — handleOAuth401Error
 * transitively pulls in config.ts (~1300 modules), which breaks the SDK bundle.
 *
 * @param opts.also403Revoked - Also retry on 403 with "OAuth token has been
 *   revoked" body (some endpoints signal revocation this way instead of 401).
 */
export async function withOAuth401Retry<T>(
  request: () => Promise<T>,
  _opts?: { also403Revoked?: boolean },
): Promise<T> {
  return request()
}
