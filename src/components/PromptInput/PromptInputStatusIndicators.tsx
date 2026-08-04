import type * as React from 'react'
import { memo } from 'react'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import { getOauthAccountInfo } from '../../utils/auth.js'
import {
  convertEffortValueToLevel,
  resolveAppliedEffort,
} from '../../utils/effort.js'
import { getJailbreakLevel } from '../../utils/jailbreak.js'
import { getPublicModelDisplayName } from '../../utils/model/model.js'
import {
  getActiveEntry,
  getSavedApiConfigs,
  getSavedClaudeAccounts,
} from '../../utils/multiAccount.js'
import { isCompactBoundaryMessage } from '../../utils/messages.js'
import type { Theme } from '../../utils/theme.js'

// Resolve the display name of the currently active source — either a Claude
// account (email/display name) or an API config (its /account label).
function getActiveSourceLabel(): string | undefined {
  const activeEntry = getActiveEntry()

  if (activeEntry?.type === 'api') {
    const cfg = getSavedApiConfigs().find(c => c.id === activeEntry.id)
    return cfg?.label ?? activeEntry.id
  }

  // No active entry, or an explicit Claude entry → the current Claude account.
  const account = getOauthAccountInfo()
  if (account) {
    return account.displayName ?? account.emailAddress
  }

  // Fall back to the saved info for a switched-but-not-current Claude account.
  if (activeEntry?.type === 'claude') {
    const saved = getSavedClaudeAccounts().find(a => a.id === activeEntry.id)
    return saved?.info.emailAddress ?? activeEntry.id
  }

  return undefined
}

type Props = {
  messages: Message[]
}

function PromptInputStatusIndicatorsInner({
  messages,
}: Props): React.ReactNode {
  // Subscribe to authVersion so the source updates on login/account switch.
  useAppState(s => s.authVersion)
  const mainLoopModel = useMainLoopModel()
  const effortValue = useAppState(s => s.effortValue)
  const thinkingEnabled = useAppState(s => s.thinkingEnabled) ?? true
  const ultracode = useAppState(s => s.ultracode) ?? false
  useAppState(s => s.jailbreakLevel)

  const sourceLabel = getActiveSourceLabel()
  const modelLabel = getPublicModelDisplayName(mainLoopModel) ?? mainLoopModel

  // Thinking is "on" only when thinkingEnabled is true, the user has set an
  // effort value, and the env override isn't disabling it.
  const appliedEffort =
    thinkingEnabled && effortValue !== undefined
      ? resolveAppliedEffort(mainLoopModel, effortValue)
      : undefined
  const thinkingLevel =
    appliedEffort !== undefined
      ? convertEffortValueToLevel(appliedEffort)
      : undefined

  const jailbreakLevel = getJailbreakLevel()
  const compactDepth = messages.filter(isCompactBoundaryMessage).length

  // Each part renders as text; ultracode gets the effortUltra accent color.
  const parts: { text: string; color?: keyof Theme }[] = []
  if (sourceLabel) parts.push({ text: sourceLabel })
  parts.push({ text: modelLabel })
  if (ultracode) {
    // Ultracode runs at xhigh; surface it as a distinct accented indicator
    // instead of the plain "thinking: xhigh" label.
    parts.push({ text: 'ultracode', color: 'effortUltra' })
  } else if (!thinkingEnabled) {
    parts.push({ text: 'thinking: off', color: 'inactive' })
  } else if (thinkingLevel) {
    parts.push({ text: `thinking: ${thinkingLevel}` })
  } else {
    parts.push({ text: 'thinking: on' })
  }
  if (compactDepth > 0) parts.push({ text: `compact ×${compactDepth}` })
  parts.push({ text: `jailbreak: ${jailbreakLevel}` })

  return (
    <Box flexDirection="row">
      <Text wrap="truncate">
        {parts.map((part, i) => (
          <Text key={part.text}>
            {i > 0 ? <Text dimColor> · </Text> : null}
            {part.color ? <Text color={part.color}>{part.text}</Text> : part.text}
          </Text>
        ))}
      </Text>
    </Box>
  )
}

export const PromptInputStatusIndicators = memo(PromptInputStatusIndicatorsInner)
