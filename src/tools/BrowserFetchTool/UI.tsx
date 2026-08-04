import React from 'react'
import { MessageResponse } from '../../components/MessageResponse.js'
import { TOOL_SUMMARY_MAX_LENGTH } from '../../constants/toolLimits.js'
import { Box, Text } from '../../ink.js'
import type { ToolProgressData } from '../../Tool.js'
import type { ProgressMessage } from '../../types/message.js'
import { formatFileSize, truncate } from '../../utils/format.js'
import type { BrowserFetchProgress, Output } from './BrowserFetchTool.js'

export function renderToolUseMessage(
  {
    url,
    browser,
    os,
  }: Partial<{
    url: string
    prompt: string
    browser: string
    os: string
  }>,
  { verbose }: { theme?: string; verbose: boolean },
): React.ReactNode {
  if (!url) {
    return null
  }
  const profile = browser ? ` (${browser}${os ? ` · ${os}` : ''})` : ''
  if (verbose) {
    return `url: "${url}"${profile}`
  }
  return `${url}${profile}`
}

export function renderToolUseProgressMessage(
  progressMessages: ProgressMessage<BrowserFetchProgress>[],
): React.ReactNode {
  const last = progressMessages[progressMessages.length - 1]?.data
  let text = 'Fetching…'
  if (last?.type === 'browserfetch_phase') {
    text =
      last.phase === 'installing'
        ? 'Downloading the Camoufox render engine (~150MB, first use only)…'
        : 'Rendering with Camoufox…'
  }
  return (
    <MessageResponse height={1}>
      <Text dimColor>{text}</Text>
    </MessageResponse>
  )
}

export function renderToolResultMessage(
  { bytes, code, codeText, result, browser, raw, rendered, challengeSolved, note }: Output,
  _progressMessagesForMessage: ProgressMessage<ToolProgressData>[],
  { verbose }: { verbose: boolean },
): React.ReactNode {
  const formattedSize = formatFileSize(bytes)
  const mode = raw ? 'raw' : 'summarized'
  const engine = rendered ? 'rendered' : 'fast'
  // After a solved Cloudflare challenge, `code` is the pre-solve 403/429/503 —
  // showing it would misleadingly imply the fetch failed. Show the real
  // outcome instead.
  const status = challengeSolved ? 'challenge solved' : `${code} ${codeText}`
  if (verbose) {
    return (
      <Box flexDirection="column">
        <MessageResponse height={1}>
          <Text>
            Received <Text bold>{formattedSize}</Text> ({status}) as {browser} (
            {engine}, {mode})
          </Text>
        </MessageResponse>
        {note ? (
          <MessageResponse height={1}>
            <Text dimColor>{note}</Text>
          </MessageResponse>
        ) : null}
        <Box flexDirection="column">
          <Text>{result}</Text>
        </Box>
      </Box>
    )
  }
  return (
    <MessageResponse height={1}>
      <Text>
        Received <Text bold>{formattedSize}</Text> ({status})
        {rendered ? ' · rendered' : ''}
      </Text>
    </MessageResponse>
  )
}

export function getToolUseSummary(
  input:
    | Partial<{ url: string; prompt: string; browser: string; os: string }>
    | undefined,
): string | null {
  if (!input?.url) {
    return null
  }
  return truncate(input.url, TOOL_SUMMARY_MAX_LENGTH)
}
