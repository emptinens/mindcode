import type * as React from 'react'
import { useEffect } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { formatCompactSummary } from '../services/compact/prompt.js'

type Props = {
  summary: string
  onDismiss: () => void
}

function summaryPreview(summary: string, width: number): string {
  const compact = formatCompactSummary(summary).replace(/\s+/g, ' ').trim()
  const maxLength = Math.max(80, Math.min(240, width * 2))
  return compact.length > maxLength
    ? `${compact.slice(0, maxLength - 1)}…`
    : compact
}

export function CompactSummaryView({
  summary,
  onDismiss,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()

  useEffect(() => {
    const timer = setTimeout(onDismiss, 15_000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="claudeBlue_FOR_SYSTEM_SPINNER"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginTop={1}
      width="100%"
    >
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER" bold>
        ✓ Conversation compacted
      </Text>
      <Text color="inactive" wrap="wrap">
        {summaryPreview(summary, columns)}
      </Text>
      <Text dimColor>Ctrl+O opens the full compact summary in transcript.</Text>
    </Box>
  )
}
