/* eslint-disable custom-rules/no-process-exit -- CLI subcommand handler intentionally exits */

import { performLogout } from '../../commands/logout/logout.js'
import { getAPIProvider } from '../../utils/model/providers.js'
import { isVexzyApiKey } from '../../services/api/vexzy/config.js'

/**
 * OAuth token installation is intentionally disabled. MindCode authenticates
 * exclusively with VEXZY_API_KEY.
 *
 * This export remains as a compatibility guard for legacy internal callers;
 * invoking it fails closed instead of starting a legacy OAuth flow.
 */
export async function installOAuthTokens(_tokens: unknown): Promise<never> {
  throw new Error(
    'MindCode requires VEXZY_API_KEY authentication; OAuth is disabled.',
  )
}

export async function authLogin(_options: unknown): Promise<void> {
  const apiKey = process.env.VEXZY_API_KEY
  if (!isVexzyApiKey(apiKey)) {
    process.stderr.write(
      'VEXZY_API_KEY is not configured. Set it before starting MindCode.\n',
    )
    process.exit(1)
  }

  process.stdout.write('VEXZY_API_KEY is configured. MindCode is ready.\n')
  process.exit(0)
}

export async function authStatus(opts: {
  json?: boolean
  text?: boolean
}): Promise<void> {
  const apiKey = process.env.VEXZY_API_KEY
  const loggedIn = isVexzyApiKey(apiKey)

  if (opts.text) {
    process.stdout.write(
      loggedIn
        ? 'VEXZY_API_KEY: configured\n'
        : 'Not authenticated. Set VEXZY_API_KEY before starting MindCode.\n',
    )
  } else {
    const output: Record<string, string | boolean> = {
      loggedIn,
      authMethod: loggedIn ? 'vexzy_api_key' : 'none',
      apiProvider: loggedIn ? getAPIProvider() : 'vexzy',
    }
    if (loggedIn) output.apiKeySource = 'VEXZY_API_KEY'
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
  }

  process.exit(loggedIn ? 0 : 1)
}

export async function authLogout(): Promise<void> {
  try {
    await performLogout({ clearOnboarding: false })
  } catch {
    process.stderr.write('Failed to clear MindCode authentication state.\n')
    process.exit(1)
  }

  process.stdout.write(
    process.env.VEXZY_API_KEY
      ? 'Local MindCode credentials cleared. VEXZY_API_KEY remains active in the environment.\n'
      : 'MindCode VEXZY authentication state cleared.\n',
  )
  process.exit(0)
}
