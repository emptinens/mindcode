import * as React from 'react'
import { memo } from 'react'
import { getSdkBetas } from '../../bootstrap/state.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { getRawUtilization } from '../../services/claudeAiLimits.js'
import { useAppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import {
  calculateContextPercentages,
  getContextWindowForModel,
} from '../../utils/context.js'
import { formatResetTime, formatTokens } from '../../utils/format.js'
import { getActiveEntry } from '../../utils/multiAccount.js'
import { getCurrentUsage } from '../../utils/tokens.js'
import { ProgressBar } from '../design-system/ProgressBar.js'

type Props = {
  messages: Message[]
}

type UsageRowProps = {
  label: string
  ratio: number
  summary: string
  detail?: string
  barWidth: number
}

function UsageRow({
  label,
  ratio,
  summary,
  detail,
  barWidth,
}: UsageRowProps): React.ReactNode {
  return (
    <Box flexDirection="row" gap={1}>
      <Text bold>{label}</Text>
      <ProgressBar
        ratio={ratio}
        width={barWidth}
        fillColor="rate_limit_fill"
        emptyColor="rate_limit_empty"
      />
      <Text wrap="truncate">{summary}</Text>
      {detail ? (
        <Text dimColor wrap="truncate">
          · {detail}
        </Text>
      ) : null}
    </Box>
  )
}

function PromptInputUsageBarsInner({
  messages,
}: Props): React.ReactNode {
  useAppState(s => s.authVersion)
  const { columns } = useTerminalSize()
  const mainLoopModel = useMainLoopModel()

  const currentUsage = getCurrentUsage(messages)
  const contextWindowSize = getContextWindowForModel(
    mainLoopModel,
    getSdkBetas(),
  )
  const contextPercentages = calculateContextPercentages(
    currentUsage,
    contextWindowSize,
  )
  const contextUsedTokens = currentUsage
    ? currentUsage.input_tokens +
      currentUsage.cache_creation_input_tokens +
      currentUsage.cache_read_input_tokens
    : 0

  const rawUtilization = getRawUtilization()
  const fiveHourLimit = rawUtilization.five_hour
  const activeEntry = getActiveEntry()
  const shouldShowFiveHourLimit =
    !activeEntry || activeEntry.type === 'claude'

  const barWidth = Math.max(10, Math.min(columns >= 120 ? 24 : 18, columns - 48))
  const contextUsedPercentage = contextPercentages.used ?? 0
  const contextRemainingPercentage = contextPercentages.remaining ?? 100
  const contextSummary = `${formatTokens(contextUsedTokens)} / ${formatTokens(contextWindowSize)}`
  const contextDetail = `${contextUsedPercentage}% used · ${contextRemainingPercentage}% left`

  const fiveHourUsedPercentage = fiveHourLimit
    ? Math.max(0, Math.min(100, Math.round(fiveHourLimit.utilization * 100)))
    : 0
  const fiveHourRemainingPercentage = 100 - fiveHourUsedPercentage
  const fiveHourSummary = fiveHourLimit
    ? `${fiveHourRemainingPercentage}% left`
    : 'unavailable'
  const resetText = fiveHourLimit?.resets_at
    ? formatResetTime(fiveHourLimit.resets_at, false, true)
    : undefined
  const sessionDetailParts = [
    fiveHourLimit ? `${fiveHourUsedPercentage}% used` : undefined,
    resetText ? `resets ${resetText}` : undefined,
  ].filter(Boolean)

  return (
    <Box flexDirection="column">
      <UsageRow
        label="Context"
        ratio={contextUsedPercentage / 100}
        summary={contextSummary}
        detail={contextDetail}
        barWidth={barWidth}
      />
      {shouldShowFiveHourLimit ? (
        <UsageRow
          label="5h limit"
          ratio={fiveHourUsedPercentage / 100}
          summary={fiveHourSummary}
          detail={sessionDetailParts.join(' · ')}
          barWidth={barWidth}
        />
      ) : null}
    </Box>
  )
}

export const PromptInputUsageBars = memo(PromptInputUsageBarsInner)
