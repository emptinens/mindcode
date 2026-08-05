import type { AssistantMessage, Message } from '../../types/message.js'

const MAX_LOOKBACK = 20

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: unknown }).type === 'text' &&
        typeof (block as { text?: unknown }).text === 'string',
    )
    .map(block => block.text)
    .join('\n\n')
    .trim()
}

/** Index 0 is the latest non-error assistant response. */
export function collectRecentAssistantTexts(messages: Message[]): string[] {
  const texts: string[] = []
  let currentResponseId: string | undefined
  let currentResponseParts: string[] = []

  const flush = () => {
    const text = currentResponseParts
      .slice()
      .reverse()
      .join('\n\n')
      .trim()
    if (text && texts.length < MAX_LOOKBACK) texts.push(text)
    currentResponseId = undefined
    currentResponseParts = []
  }

  for (
    let index = messages.length - 1;
    index >= 0 && texts.length < MAX_LOOKBACK;
    index -= 1
  ) {
    const message = messages[index]
    if (message?.type !== 'assistant' || message.isApiErrorMessage) {
      flush()
      continue
    }

    const assistant = message as AssistantMessage
    const responseId = assistant.message.id ?? assistant.uuid
    if (currentResponseId !== undefined && responseId !== currentResponseId) {
      flush()
    }
    currentResponseId = responseId

    const text = extractText(assistant.message.content)
    if (text) currentResponseParts.push(text)
  }
  flush()
  return texts
}

export function resolveCopyIndex(
  argument: string | undefined,
  available: number,
): { index: number } | { error: string } {
  const value = argument?.trim()
  if (!value) return { index: 0 }

  const requested = Number(value)
  if (!Number.isSafeInteger(requested) || requested < 1) {
    return {
      error: `Usage: /copy [N], where N is 1 (latest), 2, 3, … Got: ${value}`,
    }
  }
  if (requested > available) {
    return {
      error: `Only ${available} assistant ${available === 1 ? 'message' : 'messages'} available to copy`,
    }
  }
  return { index: requested - 1 }
}
