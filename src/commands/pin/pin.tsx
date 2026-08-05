import type * as React from 'react'
import { useMemo, useState } from 'react'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text, useInput } from '../../ink.js'
import type {
  LocalJSXCommandContext,
  LocalJSXCommandOnDone,
} from '../../types/command.js'
import type { Message } from '../../types/message.js'
import { getAssistantMessageText } from '../../utils/messages.js'
import {
  isPinned,
  pinMessage,
  unpinMessage,
} from '../../utils/pinnedMessages.js'

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function messagePreview(message: Message): string {
  if (message.type === 'assistant') {
    return getAssistantMessageText(message) ?? ''
  }
  if (message.type !== 'user') return ''

  const content = message.message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        block.type === 'text',
    )
    .map(block => block.text)
    .join(' ')
}

function pinnableMessages(messages: Message[]): Message[] {
  return messages
    .filter(
      message =>
        (message.type === 'user' || message.type === 'assistant') &&
        messagePreview(message).trim().length > 0,
    )
    .reverse()
}

function togglePin(message: Message): 'pinned' | 'unpinned' {
  if (isPinned(message.uuid)) {
    unpinMessage(message.uuid)
    return 'unpinned'
  }
  pinMessage({
    uuid: message.uuid,
    preview: messagePreview(message).slice(0, 240),
    role: message.type as 'user' | 'assistant',
    pinnedAt: Date.now(),
  })
  return 'pinned'
}

type PinPickerProps = {
  onDone: LocalJSXCommandOnDone
  messages: Message[]
  initialQuery: string
}

function PinPicker({
  onDone,
  messages,
  initialQuery,
}: PinPickerProps): React.ReactNode {
  const [query, setQuery] = useState(initialQuery)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const { columns } = useTerminalSize()

  const filtered = useMemo(() => {
    const normalized = query.toLowerCase()
    const candidates = pinnableMessages(messages)
    return normalized
      ? candidates.filter(message =>
          messagePreview(message).toLowerCase().includes(normalized),
        )
      : candidates
  }, [messages, query])

  const clampedIndex = Math.min(
    selectedIndex,
    Math.max(0, filtered.length - 1),
  )
  const maxVisible = 10
  const windowStart = Math.max(
    0,
    Math.min(clampedIndex - maxVisible + 1, filtered.length - maxVisible),
  )
  const visibleMessages = filtered.slice(
    windowStart,
    windowStart + maxVisible,
  )

  useInput((input, key, event) => {
    event.stopImmediatePropagation()
    if (key.escape || (key.ctrl && input === 'c')) {
      onDone(undefined, { display: 'skip', shouldQuery: false })
      return
    }
    if (key.return) {
      const message = filtered[clampedIndex]
      if (!message) {
        onDone('No message selected', {
          display: 'system',
          shouldQuery: false,
        })
        return
      }
      const result = togglePin(message)
      onDone(
        result === 'pinned'
          ? 'Pinned message · Ctrl+P to view'
          : 'Unpinned message',
        { display: 'system', shouldQuery: false },
      )
      return
    }
    if (key.upArrow) {
      setSelectedIndex(index => Math.max(0, index - 1))
      return
    }
    if (key.downArrow) {
      setSelectedIndex(index =>
        Math.min(Math.max(0, filtered.length - 1), index + 1),
      )
      return
    }
    if (key.backspace || key.delete) {
      setQuery(value => value.slice(0, -1))
      setSelectedIndex(0)
      return
    }
    if (!key.ctrl && !key.meta && input.length > 0) {
      setQuery(value => value + input)
      setSelectedIndex(0)
    }
  })

  const maxWidth = Math.max(20, Math.min(columns - 4, 100))
  const previewWidth = Math.max(10, maxWidth - 20)

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
          Pin a message
        </Text>
        <Text dimColor>↑↓ · Enter · Esc</Text>
      </Box>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text dimColor>Search</Text>
        <Text>
          {query}
          <Text color="suggestion">▌</Text>
        </Text>
      </Box>
      <Box height={1} />
      {visibleMessages.length === 0 ? (
        <Text dimColor>No messages match “{query}”</Text>
      ) : (
        visibleMessages.map((message, visibleIndex) => {
          const absoluteIndex = windowStart + visibleIndex
          const selected = absoluteIndex === clampedIndex
          const preview = messagePreview(message)
            .replace(/\s+/g, ' ')
            .slice(0, previewWidth)
          return (
            <Box key={message.uuid} flexDirection="row" gap={1}>
              <Text color={selected ? 'suggestion' : 'subtle'}>
                {selected ? '›' : ' '}
              </Text>
              <Text
                color={message.type === 'user' ? 'success' : 'claude'}
                bold={selected}
              >
                {message.type === 'user' ? 'you' : 'MindCode'}
              </Text>
              {isPinned(message.uuid) ? (
                <Text color="warning">●</Text>
              ) : null}
              <Text
                color={selected ? 'text' : 'inactive'}
                wrap="truncate"
              >
                {preview}
              </Text>
            </Box>
          )
        })
      )}
      {filtered.length > maxVisible ? (
        <Text dimColor>
          {windowStart + 1}–{Math.min(windowStart + maxVisible, filtered.length)}{' '}
          of {filtered.length}
        </Text>
      ) : null}
    </Box>
  )
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
  args: string,
): Promise<React.ReactNode> {
  const query = args.trim()

  if (UUID_RE.test(query)) {
    const message = context.messages.find(candidate => candidate.uuid === query)
    if (!message || (message.type !== 'user' && message.type !== 'assistant')) {
      return (
        <Box>
          <Text color="error">No pinnable message with UUID {query}</Text>
        </Box>
      )
    }
    const result = togglePin(message)
    onDone(
      result === 'pinned'
        ? 'Pinned message · Ctrl+P to view'
        : 'Unpinned message',
      { display: 'system', shouldQuery: false },
    )
    return null
  }

  return (
    <PinPicker
      onDone={onDone}
      messages={context.messages}
      initialQuery={query}
    />
  )
}
