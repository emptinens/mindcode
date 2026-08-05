import type {
  ThinkingBlock,
  ThinkingBlockParam,
} from '../../services/api/vexzy/protocolTypes.js'
import type * as React from 'react'
import { Box, Text } from '../../ink.js'
import { CtrlOToExpand } from '../CtrlOToExpand.js'
import { Markdown, StreamingMarkdown } from '../Markdown.js'

type Props = {
  param:
    | ThinkingBlock
    | ThinkingBlockParam
    | { type: 'thinking'; thinking: string }
  addMargin: boolean
  isTranscriptMode: boolean
  verbose: boolean
  hideInTranscript?: boolean
  isStreaming?: boolean
}

export function AssistantThinkingMessage({
  param: { thinking },
  addMargin = false,
  isTranscriptMode,
  verbose,
  hideInTranscript = false,
  isStreaming = false,
}: Props): React.ReactNode {
  if (!thinking || hideInTranscript) return null

  const expanded = isTranscriptMode || verbose || isStreaming

  if (!expanded) {
    return (
      <Box
        borderStyle="single"
        borderColor="suggestion"
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        paddingLeft={1}
        marginTop={addMargin ? 1 : 0}
      >
        <Text>
          <Text color="suggestion" bold>
            ✦ Thought process
          </Text>{' '}
          <CtrlOToExpand />
        </Text>
      </Box>
    )
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor="suggestion"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      paddingLeft={1}
      marginTop={addMargin ? 1 : 0}
      width="100%"
    >
      <Box flexDirection="row" gap={1}>
        <Text color="suggestion" bold>
          ✦ {isStreaming ? 'Thinking' : 'Thought process'}
        </Text>
        {isStreaming ? (
          <Text color="success" bold>
            ● live
          </Text>
        ) : (
          <Text dimColor>reasoning</Text>
        )}
      </Box>
      <Box paddingLeft={1} marginTop={1}>
        {isStreaming ? (
          <StreamingMarkdown>{thinking}</StreamingMarkdown>
        ) : (
          <Markdown>{thinking}</Markdown>
        )}
      </Box>
    </Box>
  )
}
