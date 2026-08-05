import type {
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlockParam,
  ContentBlock,
  ContentBlockParam,
} from 'src/services/api/vexzy/protocolTypes.js'
import type { Attachment } from '../utils/attachments.js'
import { normalizeAttachmentForAPI } from '../utils/messages.js'
import { jsonStringify } from '../utils/slowOperations.js'
import { isToolReferenceBlock } from '../utils/toolSearch.js'
import { withTokenCountVCR } from './vcr.js'

/**
 * Token counting is deliberately local. VEXZY does not require a separate
 * provider-specific count-tokens endpoint, so estimation never selects a
 * model, calls Bedrock/Vertex, or imports a cloud SDK.
 */
export async function countTokensWithAPI(
  content: string,
): Promise<number | null> {
  if (!content) return 0
  return countMessagesTokensWithAPI([{ role: 'user', content }], [])
}

export async function countMessagesTokensWithAPI(
  messages: BetaMessageParam[],
  tools: BetaToolUnion[],
): Promise<number | null> {
  return withTokenCountVCR(messages, tools, async () => {
    const normalized = stripToolSearchFieldsFromMessages(messages)
    let tokens = roughTokenCountEstimationForMessages(
      normalized.map(message => ({
        type: message.role,
        message: { content: message.content },
      })),
    )
    if (tools.length > 0) {
      tokens += roughTokenCountEstimation(jsonStringify(tools))
    }
    return tokens
  })
}

export function roughTokenCountEstimation(
  content: string,
  bytesPerToken = 4,
): number {
  return Math.round(content.length / bytesPerToken)
}

export function bytesPerTokenForFileType(fileExtension: string): number {
  switch (fileExtension.toLowerCase()) {
    case 'json':
    case 'jsonl':
    case 'jsonc':
      return 2
    default:
      return 4
  }
}

export function roughTokenCountEstimationForFileType(
  content: string,
  fileExtension: string,
): number {
  return roughTokenCountEstimation(
    content,
    bytesPerTokenForFileType(fileExtension),
  )
}

/** Local fallback retained under the historical API-facing name. */
export async function countTokensViaHaikuFallback(
  messages: BetaMessageParam[],
  tools: BetaToolUnion[],
): Promise<number | null> {
  return countMessagesTokensWithAPI(messages, tools)
}

export function roughTokenCountEstimationForMessages(
  messages: readonly {
    type: string
    message?: { content?: unknown }
    attachment?: Attachment
  }[],
): number {
  let totalTokens = 0
  for (const message of messages) {
    totalTokens += roughTokenCountEstimationForMessage(message)
  }
  return totalTokens
}

export function roughTokenCountEstimationForMessage(message: {
  type: string
  message?: { content?: unknown }
  attachment?: Attachment
}): number {
  if (
    (message.type === 'assistant' || message.type === 'user') &&
    message.message?.content
  ) {
    return roughTokenCountEstimationForContent(
      message.message.content as
        | string
        | Array<ContentBlock>
        | Array<ContentBlockParam>
        | undefined,
    )
  }

  if (message.type === 'attachment' && message.attachment) {
    return normalizeAttachmentForAPI(message.attachment).reduce(
      (total, userMessage) =>
        total + roughTokenCountEstimationForContent(userMessage.message.content),
      0,
    )
  }

  return 0
}

function roughTokenCountEstimationForContent(
  content: string | Array<ContentBlock> | Array<ContentBlockParam> | undefined,
): number {
  if (!content) return 0
  if (typeof content === 'string') return roughTokenCountEstimation(content)
  return content.reduce(
    (total, block) => total + roughTokenCountEstimationForBlock(block),
    0,
  )
}

function roughTokenCountEstimationForBlock(
  block: string | ContentBlock | ContentBlockParam,
): number {
  if (typeof block === 'string') return roughTokenCountEstimation(block)
  if (block.type === 'text') return roughTokenCountEstimation(block.text)
  if (block.type === 'image' || block.type === 'document') return 2_000
  if (block.type === 'tool_result') {
    return roughTokenCountEstimationForContent(block.content)
  }
  if (block.type === 'tool_use') {
    return roughTokenCountEstimation(
      block.name + jsonStringify(block.input ?? {}),
    )
  }
  if (block.type === 'thinking') {
    return roughTokenCountEstimation(block.thinking)
  }
  if (block.type === 'redacted_thinking') {
    return roughTokenCountEstimation(block.data)
  }
  return roughTokenCountEstimation(jsonStringify(block))
}

function stripToolSearchFieldsFromMessages(
  messages: BetaMessageParam[],
): BetaMessageParam[] {
  return messages.map(message => {
    if (!Array.isArray(message.content)) return message

    const content = message.content.map(block => {
      if (block.type === 'tool_use') {
        const toolUse = block as BetaToolUseBlockParam & { caller?: unknown }
        return {
          type: 'tool_use' as const,
          id: toolUse.id,
          name: toolUse.name,
          input: toolUse.input,
        }
      }

      if (block.type === 'tool_result') {
        const toolResult = block as BetaToolResultBlockParam
        if (Array.isArray(toolResult.content)) {
          const filtered = (toolResult.content as unknown[]).filter(
            value => !isToolReferenceBlock(value),
          ) as typeof toolResult.content
          return filtered.length > 0
            ? { ...toolResult, content: filtered }
            : {
                ...toolResult,
                content: [{ type: 'text' as const, text: '[tool references]' }],
              }
        }
      }

      return block
    })

    return { ...message, content }
  })
}
