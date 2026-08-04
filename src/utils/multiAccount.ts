import { randomUUID } from 'crypto'
import { getOauthConfig } from '../constants/oauth.js'
import type { AccountInfo, ActiveEntry, ApiConfig } from './config.js'
import { getGlobalConfig, saveGlobalConfig } from './config.js'
import { getSecureStorage } from './secureStorage/index.js'
import type { OAuthTokenData } from './secureStorage/types.js'

let activeApiOverride: ApiConfig | null = null

export function getActiveApiOverride(): ApiConfig | null {
  return activeApiOverride
}

export function getActiveBaseUrl(): string {
  return (
    activeApiOverride?.baseUrl ??
    process.env.ANTHROPIC_BASE_URL ??
    getOauthConfig().BASE_API_URL
  )
}

export function getActiveAuthToken(): string | undefined {
  return activeApiOverride?.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN
}

export function initActiveEntry(): void {
  const config = getGlobalConfig()
  const entry = config.activeEntry
  if (!entry) return

  if (entry.type === 'api') {
    const found = config.savedApiConfigs?.find(c => c.id === entry.id) ?? null
    activeApiOverride = found
  } else {
    activeApiOverride = null
  }
}

export function addApiConfig(
  label: string,
  apiKey?: string,
  baseUrl?: string,
  authToken?: string,
): ApiConfig {
  const config: ApiConfig = {
    id: randomUUID(),
    label,
    ...(apiKey ? { apiKey } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(authToken ? { authToken } : {}),
  }
  saveGlobalConfig(current => ({
    ...current,
    savedApiConfigs: [...(current.savedApiConfigs ?? []), config],
  }))
  return config
}

export function removeEntry(id: string): void {
  const config = getGlobalConfig()
  const entry = config.activeEntry

  saveGlobalConfig(current => {
    const updated = { ...current }
    updated.savedApiConfigs = (current.savedApiConfigs ?? []).filter(
      c => c.id !== id,
    )
    const { [id]: _removed, ...remainingInfos } =
      current.savedClaudeAccountInfos ?? {}
    updated.savedClaudeAccountInfos = remainingInfos

    const secureStorage = getSecureStorage()
    const data = secureStorage.read() ?? {}
    const { [id]: _tokens, ...remainingAccounts } =
      data.savedClaudeAccounts ?? {}
    secureStorage.update({ ...data, savedClaudeAccounts: remainingAccounts })

    if (entry?.id === id) {
      updated.activeEntry = undefined
      activeApiOverride = null
    }
    return updated
  })
}

export function switchActiveEntry(
  newEntry: ActiveEntry,
  onSwitched: () => void,
): void {
  const config = getGlobalConfig()
  const secureStorage = getSecureStorage()
  const storageData = secureStorage.read() ?? {}

  // Save current Claude account's tokens back before switching away
  const prev = config.activeEntry
  if (prev?.type === 'claude') {
    const currentTokens = storageData.claudeAiOauth
    if (currentTokens) {
      secureStorage.update({
        ...storageData,
        savedClaudeAccounts: {
          ...storageData.savedClaudeAccounts,
          [prev.id]: currentTokens,
        },
      })
    }
  }

  if (newEntry.type === 'api') {
    const found =
      config.savedApiConfigs?.find(c => c.id === newEntry.id) ?? null
    activeApiOverride = found
  } else {
    // Switching to a Claude account: copy its tokens into claudeAiOauth
    const tokens = storageData.savedClaudeAccounts?.[newEntry.id]
    if (tokens) {
      secureStorage.update({
        ...storageData,
        claudeAiOauth: tokens,
      })
    }
    // Update oauthAccount in config to match the new active account
    const accountInfo = config.savedClaudeAccountInfos?.[newEntry.id]
    if (accountInfo) {
      saveGlobalConfig(current => ({ ...current, oauthAccount: accountInfo }))
    }
    activeApiOverride = null
  }

  saveGlobalConfig(current => ({ ...current, activeEntry: newEntry }))
  onSwitched()
}

export function saveClaudeAccountForMultiAccount(
  accountInfo: AccountInfo,
  tokens: OAuthTokenData,
): void {
  const id = accountInfo.accountUuid
  saveGlobalConfig(current => ({
    ...current,
    savedClaudeAccountInfos: {
      ...current.savedClaudeAccountInfos,
      [id]: accountInfo,
    },
  }))

  const secureStorage = getSecureStorage()
  const data = secureStorage.read() ?? {}
  secureStorage.update({
    ...data,
    savedClaudeAccounts: {
      ...data.savedClaudeAccounts,
      [id]: tokens,
    },
  })
}

export function getSavedClaudeAccounts(): Array<{
  id: string
  info: AccountInfo
}> {
  const config = getGlobalConfig()
  const infos = config.savedClaudeAccountInfos ?? {}
  return Object.entries(infos).map(([id, info]) => ({ id, info }))
}

export function getSavedApiConfigs(): ApiConfig[] {
  return getGlobalConfig().savedApiConfigs ?? []
}

export function getActiveEntry(): ActiveEntry | undefined {
  return getGlobalConfig().activeEntry
}
