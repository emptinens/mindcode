import type * as React from 'react'
import { Box, Text, useAnimationFrame } from '../ink.js'

export type CompactProgressState = {
  mode: 'indeterminate'
  elapsedLabel: string
  indicator: string
}

export function getCompactProgressState(
  elapsedMs: number,
): CompactProgressState {
  const clampedElapsedMs = Math.max(0, elapsedMs)
  const pulse = Math.floor(clampedElapsedMs / 400) % 4
  const elapsedSeconds = Math.floor(clampedElapsedMs / 1000)
  return {
    mode: 'indeterminate',
    elapsedLabel: `${elapsedSeconds}s`,
    indicator: `${' '.repeat(pulse)}${'.'.repeat(3 - pulse)}`,
  }
}

type Props = {
  startTime: number
}

export function CompactProgressBar({
  startTime,
}: Props): React.ReactNode {
  const [viewportRef] = useAnimationFrame(50)
  const elapsed = Math.max(0, Date.now() - startTime)
  const progress = getCompactProgressState(elapsed)

  return (
    <Box ref={viewportRef} flexDirection="row" gap={1} marginTop={1}>
      <Text color="claudeBlue_FOR_SYSTEM_SPINNER" bold>
        Compacting{progress.indicator}
      </Text>
      <Text dimColor>{progress.elapsedLabel}</Text>
    </Box>
  )
}
