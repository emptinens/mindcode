import { isHumanTurn } from '../../utils/messagePredicates.js'

type Message = Parameters<typeof isHumanTurn>[0]

export function hasPendingAssistantTurn(messages: Message[]): boolean {
  let lastHumanTurn = -1
  let lastCompletion = -1

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (!message) continue
    if (isHumanTurn(message)) lastHumanTurn = index
    if (message.type === 'assistant' || message.type === 'system') {
      lastCompletion = index
    }
  }

  return lastHumanTurn > lastCompletion
}
