import { getOrganizationUUID } from '../auth.js'
import { getClaudeAIOAuthTokens } from '../auth.js'

/**
 * Shared OAuth request preparation retained for legacy account-scoped API
 * helpers. Session creation, transcript transport, and remote-session APIs are
 * intentionally not implemented in the local runtime.
 */
export async function prepareApiRequest(): Promise<{
  accessToken: string
  orgUUID: string
}> {
  const accessToken = getClaudeAIOAuthTokens()?.accessToken
  if (accessToken === undefined) {
    throw new Error(
      'Account-scoped requests require an authenticated account. Please run /login or check authentication status.',
    )
  }

  const orgUUID = await getOrganizationUUID()
  if (!orgUUID) {
    throw new Error('Unable to get organization UUID')
  }

  return { accessToken, orgUUID }
}

/**
 * Shared headers for legacy account-scoped requests. This helper does not
 * create, resume, stream, or upload session data.
 */
export function getOAuthHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  }
}
