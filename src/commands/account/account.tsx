import * as React from 'react'
import { useState } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import type { CommandResultDisplay } from '../../commands.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Select } from '../../components/CustomSelect/index.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import TextInput from '../../components/TextInput.js'
import { Box, Text, useInput } from '../../ink.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { checkQuotaStatus } from '../../services/claudeAiLimits.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import type { ActiveEntry } from '../../utils/config.js'
import { getGlobalConfig } from '../../utils/config.js'
import { logError } from '../../utils/log.js'
import {
  addApiConfig,
  getActiveEntry,
  getSavedApiConfigs,
  getSavedClaudeAccounts,
  removeEntry,
  saveClaudeAccountForMultiAccount,
  switchActiveEntry,
} from '../../utils/multiAccount.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearAuthRelatedCaches } from '../logout/logout.js'

type View =
  | 'list'
  | 'add-api-label'
  | 'add-api-key'
  | 'add-api-baseurl'
  | 'add-api-authtoken'
  | 'add-claude'
  | 'confirm-remove'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

function TextStep({
  title,
  hint,
  onSubmit,
  onCancel,
  mask,
}: {
  title: string
  hint: string
  onSubmit: (value: string) => void
  onCancel: () => void
  mask?: string
}): React.ReactNode {
  const [value, setValue] = useState('')
  const [cursorOffset, setCursorOffset] = useState(0)
  const columns = useTerminalSize().columns - 4
  useInput((_input, key) => {
    if (key.escape) onCancel()
  })
  return (
    <Dialog
      title={title}
      onCancel={onCancel}
      color="permission"
      isCancelActive={false}
    >
      <Box flexDirection="column" gap={1}>
        <Text dimColor>{hint}</Text>
        <TextInput
          value={value}
          onChange={setValue}
          cursorOffset={cursorOffset}
          onChangeCursorOffset={setCursorOffset}
          columns={columns}
          onSubmit={onSubmit}
          {...(mask ? { mask } : {})}
          showCursor
        />
      </Box>
    </Dialog>
  )
}

function AccountCommand({
  onDone,
  onAuthChanged,
}: {
  onDone: OnDone
  onAuthChanged: () => void
}): React.ReactNode {
  const [view, setView] = useState<View>('list')
  const [pendingApiLabel, setPendingApiLabel] = useState('')
  const [pendingApiKey, setPendingApiKey] = useState('')
  const [pendingApiBaseUrl, setPendingApiBaseUrl] = useState('')
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null)

  const activeEntry = getActiveEntry()
  const claudeAccounts = getSavedClaudeAccounts()
  const apiConfigs = getSavedApiConfigs()

  // Also include the current session's Claude account if not yet saved to multi-account
  const currentAccount = getOauthAccountInfo()
  const currentAccountAlreadySaved =
    currentAccount &&
    claudeAccounts.some(a => a.id === currentAccount.accountUuid)
  const allClaudeAccounts =
    currentAccount && !currentAccountAlreadySaved
      ? [
          { id: currentAccount.accountUuid, info: currentAccount },
          ...claudeAccounts,
        ]
      : claudeAccounts

  function isActive(entry: ActiveEntry): boolean {
    if (!activeEntry) {
      // no explicit active entry -> current Claude session is active
      return (
        entry.type === 'claude' &&
        entry.id === currentAccount?.accountUuid &&
        !currentAccountAlreadySaved
      )
    }
    return activeEntry.type === entry.type && activeEntry.id === entry.id
  }

  async function handleSwitch(entry: ActiveEntry): Promise<void> {
    // Save current account info before switch if it isn't saved yet
    if (!activeEntry && currentAccount && !currentAccountAlreadySaved) {
      const storage = getSecureStorage()
      const data = storage.read() ?? {}
      const tokens = data.claudeAiOauth
      if (tokens) {
        saveClaudeAccountForMultiAccount(currentAccount, tokens)
      }
    }

    switchActiveEntry(entry, async () => {
      await clearAuthRelatedCaches()
      onAuthChanged()
      void checkQuotaStatus().catch(error => logError(error as Error))
    })

    const label =
      entry.type === 'api'
        ? apiConfigs.find(c => c.id === entry.id)?.label ?? entry.id
        : allClaudeAccounts.find(a => a.id === entry.id)?.info.emailAddress ??
          entry.id
    onDone(`Switched to ${label}`, { display: 'system' })
  }

  function handleRemoveConfirm(): void {
    if (!removeTargetId) return
    removeEntry(removeTargetId)
    setRemoveTargetId(null)
    onDone('Entry removed', { display: 'system' })
  }

  function buildListOptions() {
    const options: Array<{
      label: string
      value: string
      description?: string
    }> = []

    for (const acc of allClaudeAccounts) {
      const active = isActive({ type: 'claude', id: acc.id })
      options.push({
        value: `claude:${acc.id}`,
        label: acc.info.emailAddress ?? acc.id,
        description: active ? '[active]' : undefined,
      })
    }

    for (const cfg of apiConfigs) {
      const active = isActive({ type: 'api', id: cfg.id })
      const summary = cfg.apiKey
        ? `API key: ${cfg.apiKey.slice(0, 8)}...`
        : cfg.authToken
          ? 'Auth token configured'
          : cfg.baseUrl
            ? 'Custom base URL'
            : 'Custom API config'
      options.push({
        value: `api:${cfg.id}`,
        label: cfg.label,
        description: active ? '[active]' : summary,
      })
    }

    options.push({ value: '__add_api__', label: 'Add API config...' })
    options.push({ value: '__add_claude__', label: 'Add Claude account...' })

    if (options.length > 2) {
      options.push({ value: '__remove__', label: 'Remove an entry...' })
    }

    return options
  }

  function handleListSelect(value: string): void {
    if (value === '__add_api__') {
      setView('add-api-label')
      return
    }
    if (value === '__add_claude__') {
      setView('add-claude')
      return
    }
    if (value === '__remove__') {
      setView('confirm-remove')
      return
    }

    const [type, id] = value.split(':') as ['claude' | 'api', string]
    const entry: ActiveEntry = { type, id }
    if (!isActive(entry)) {
      void handleSwitch(entry)
    } else {
      onDone('Already the active account', { display: 'system' })
    }
  }

  if (view === 'add-api-label') {
    return (
      <TextStep
        key="add-api-label"
        title="Add API Config - Label"
        hint='Enter a name for this API config (e.g. "OpenRouter")'
        onCancel={() => onDone()}
        onSubmit={val => {
          if (!val.trim()) return
          setPendingApiLabel(val.trim())
          setView('add-api-key')
        }}
      />
    )
  }

  if (view === 'add-api-key') {
    return (
      <TextStep
        key="add-api-key"
        title="Add API Config - API Key"
        hint="Enter an API key, or press Enter to skip"
        onCancel={() => onDone()}
        onSubmit={val => {
          setPendingApiKey(val.trim())
          setView('add-api-baseurl')
        }}
      />
    )
  }

  if (view === 'add-api-baseurl') {
    return (
      <TextStep
        key="add-api-baseurl"
        title="Add API Config - Base URL (optional)"
        hint="Enter a custom base URL, or press Enter to skip"
        onCancel={() => onDone()}
        onSubmit={val => {
          setPendingApiBaseUrl(val.trim())
          setView('add-api-authtoken')
        }}
      />
    )
  }

  if (view === 'add-api-authtoken') {
    return (
      <TextStep
        key="add-api-authtoken"
        title="Add API Config - Auth Token (optional)"
        hint="Enter an ANTHROPIC_AUTH_TOKEN value, or press Enter to skip"
        onCancel={() => onDone()}
        onSubmit={val => {
          const cfg = addApiConfig(
            pendingApiLabel,
            pendingApiKey || undefined,
            pendingApiBaseUrl || undefined,
            val.trim() || undefined,
          )
          onDone(`Added API config "${cfg.label}"`, { display: 'system' })
        }}
      />
    )
  }

  if (view === 'add-claude') {
    // Snapshot current Claude tokens so we don't lose them when installOAuthTokens runs
    const storage = getSecureStorage()
    const snapshotData = storage.read() ?? {}
    const snapshotTokens = snapshotData.claudeAiOauth
    const snapshotAccountInfo = getGlobalConfig().oauthAccount

    if (snapshotTokens && snapshotAccountInfo && !currentAccountAlreadySaved) {
      saveClaudeAccountForMultiAccount(snapshotAccountInfo, snapshotTokens)
    }

    return (
      <Dialog
        title="Add Claude Account"
        onCancel={() => setView('list')}
        color="permission"
      >
        <ConsoleOAuthFlow
          onDone={() => {
            // After installOAuthTokens completes, the new account is in claudeAiOauth + oauthAccount
            const newData = getSecureStorage().read() ?? {}
            const newTokens = newData.claudeAiOauth
            const newAccountInfo = getGlobalConfig().oauthAccount
            if (newTokens && newAccountInfo) {
              saveClaudeAccountForMultiAccount(newAccountInfo, newTokens)
              const newEntry: ActiveEntry = {
                type: 'claude',
                id: newAccountInfo.accountUuid,
              }
              switchActiveEntry(newEntry, async () => {
                await clearAuthRelatedCaches()
                onAuthChanged()
                void checkQuotaStatus().catch(error => logError(error as Error))
              })
            }
            onDone(
              `Added and switched to ${newAccountInfo?.emailAddress ?? 'new account'}`,
              {
                display: 'system',
              },
            )
          }}
        />
      </Dialog>
    )
  }

  if (view === 'confirm-remove') {
    const removeOptions = [
      ...allClaudeAccounts.map(acc => ({
        value: acc.id,
        label: acc.info.emailAddress ?? acc.id,
        description: 'Claude account',
      })),
      ...apiConfigs.map(cfg => ({
        value: cfg.id,
        label: cfg.label,
        description: 'API config',
      })),
    ]

    if (removeTargetId) {
      return (
        <Dialog
          title="Confirm removal"
          onCancel={() => setRemoveTargetId(null)}
          color="warning"
        >
          <Box flexDirection="column" gap={1}>
            <Text>Remove this entry? This cannot be undone.</Text>
            <Select
              options={[
                { value: 'yes', label: 'Yes, remove it' },
                { value: 'no', label: 'Cancel' },
              ]}
              onChange={val => {
                if (val === 'yes') handleRemoveConfirm()
                else setRemoveTargetId(null)
              }}
            />
          </Box>
        </Dialog>
      )
    }

    return (
      <Dialog
        title="Remove Entry"
        onCancel={() => setView('list')}
        color="warning"
      >
        <Select
          options={removeOptions}
          onCancel={() => setView('list')}
          onChange={id => setRemoveTargetId(id)}
        />
      </Dialog>
    )
  }

  return (
    <Dialog
      title="Accounts & API Configs"
      onCancel={() => onDone()}
      color="permission"
    >
      <Select
        options={buildListOptions()}
        onCancel={() => onDone()}
        onChange={handleListSelect}
      />
    </Dialog>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  // Ensure current session account is reflected before rendering
  await clearAuthRelatedCaches()

  return (
    <AccountCommand
      onDone={onDone}
      onAuthChanged={() => {
        context.onChangeAPIKey()
        context.setAppState(prev => ({
          ...prev,
          authVersion: prev.authVersion + 1,
        }))
      }}
    />
  )
}
