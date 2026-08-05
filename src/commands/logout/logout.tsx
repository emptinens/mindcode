import type * as React from 'react'
import { Text } from '../../ink.js'
import { removeApiKey } from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearDeprecatedAccountCredentials } from '../../utils/secureStorage/clearDeprecatedAccountCredentials.js'

export async function performLogout({
  clearOnboarding = false,
}: {
  clearOnboarding?: boolean
} = {}): Promise<void> {
  await removeApiKey()

  // Remove legacy account material so it cannot be selected by a future
  // compatibility path without deleting unrelated MCP OAuth credentials.
  // Runtime authentication remains VEXZY_API_KEY only.
  clearDeprecatedAccountCredentials(getSecureStorage())

  saveGlobalConfig(current => {
    const updated = { ...current }
    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false
      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }
    updated.oauthAccount = undefined
    updated.savedClaudeAccountInfos = undefined
    updated.activeEntry = undefined
    return updated
  })

  await clearAuthRelatedCaches()
}

export async function clearAuthRelatedCaches(): Promise<void> {
  clearBetasCaches()
  clearToolSchemaCache()
}

export async function call(): Promise<React.ReactNode> {
  await performLogout({ clearOnboarding: true })
  const message = <Text>MindCode VEXZY authentication state cleared.</Text>
  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, 200)
  return message
}
