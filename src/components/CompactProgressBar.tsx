import type * as React from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, useAnimationFrame } from '../ink.js'
import { ProgressBar } from './design-system/ProgressBar.js'

const EXPECTED_DURATION_MS = 20_000

type Props = {
  startTime: number
}

export function CompactProgressBar({
  startTime,
}: Props): React.ReactNode {
  const [viewportRef] = useAnimationFrame(50)
  const { columns } = useTerminalSize()
  const elapsed = Math.max(0, Date.now() - startTime)
  const ratio =
    0.97 * (1 - Math.exp((-elapsed / EXPECTED_DURATION_MS) * 2.5))
  const barWidth = Math.max(8, Math.min(32, columns - 30))

  return (
    <Box ref={viewportRef} flexDirection="row" gap={1} marginTop={1}>
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER" bold>
        Compacting
      </Text>
      <ProgressBar
        ratio={ratio}
        width={barWidth}
        fillColor="claudeBlue_FOR_SYSTEM_SPINNER"
        emptyColor="rate_limit_empty"
      />
      <Text dimColor>{Math.round(ratio * 100)}%</Text>
    </Box>
  )
}
