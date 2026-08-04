import type * as React from 'react'
import { useState, useSyncExternalStore } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../ink.js'
import {
  getPinnedMessages,
  subscribePins,
  unpinMessage,
} from '../utils/pinnedMessages.js'

type Props = {
  onClose: () => void
}

export function PinnedMessagesViewer({ onClose }: Props): React.ReactNode {
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { columns, rows } = useTerminalSize()
  const pins = useSyncExternalStore(
    subscribePins,
    getPinnedMessages,
    getPinnedMessages,
  )

  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, pins.length - 1),
  )
  const maxVisible = Math.max(3, Math.min(10, rows - 10))
  const windowStart = Math.max(
    0,
    Math.min(clampedIndex - maxVisible + 1, pins.length - maxVisible),
  )
  const visiblePins = pins.slice(windowStart, windowStart + maxVisible)

  useInput((input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape || input === 'q' || (key.ctrl && input === 'p')) {
      onClose()
      return
    }
    if (key.upArrow || input === 'k') {
      setSelectedIndex(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow || input === 'j') {
      setSelectedIndex(index =>
        Math.min(Math.max(0, pins.length - 1), index + 1),
      )
      return
    }
    if (input === 'u') {
      const pin = pins[clampedIndex]
      if (pin) {
        unpinMessage(pin.uuid)
        setSelectedIndex(index =>
          Math.min(index, Math.max(0, pins.length - 2)),
        )
      }
    }
  })

  const maxWidth = Math.max(20, Math.min(columns - 4, 100))

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="suggestion"
      paddingX={1}
      width={maxWidth}
    >
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="suggestion">
          Pinned context {pins.length > 0 ? `(${pins.length})` : ''}
        </Text>
        <Text dimColor>↑↓ · U unpin · Esc</Text>
      </Box>
      <Box height={1} />
      {pins.length === 0 ? (
        <Text dimColor>No pins yet. Use /pin to add one.</Text>
      ) : (
        visiblePins.map((pin, visibleIndex) => {
          const absoluteIndex = windowStart + visibleIndex
          const selected = absoluteIndex === clampedIndex
          return (
            <Box
              key={pin.uuid}
              flexDirection="column"
              marginBottom={1}
            >
              <Box flexDirection="row" gap={1}>
                <Text color={selected ? 'suggestion' : 'subtle'}>
                  {selected ? '›' : ' '}
                </Text>
                <Text
                  color={pin.role === 'user' ? 'success' : 'claude'}
                  bold={selected}
                >
                  {pin.role === 'user' ? 'you' : 'claude'}
                </Text>
                <Text dimColor>·</Text>
                <Text dimColor>
                  {new Date(pin.pinnedAt).toLocaleTimeString()}
                </Text>
              </Box>
              <Box paddingLeft={2}>
                <Text
                  wrap="wrap"
                  color={selected ? 'text' : 'inactive'}
                >
                  {pin.preview}
                </Text>
              </Box>
            </Box>
          )
        })
      )}
      {pins.length > maxVisible ? (
        <Text dimColor>
          {windowStart + 1}–{Math.min(windowStart + maxVisible, pins.length)} of{' '}
          {pins.length}
        </Text>
      ) : null}
    </Box>
  )
}
