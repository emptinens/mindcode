import { expect, test } from 'bun:test'
import { hasPendingAssistantTurn } from './processingStatus.js'

type StatusMessage = Parameters<typeof hasPendingAssistantTurn>[0][number]

const message = (
  type: StatusMessage['type'],
  overrides: object = {},
): StatusMessage => ({ type, ...overrides }) as StatusMessage

test('pending assistant turn follows the latest unresolved human message', () => {
  expect(hasPendingAssistantTurn([])).toBe(false)
  expect(hasPendingAssistantTurn([message('user')])).toBe(true)
  expect(
    hasPendingAssistantTurn([message('user'), message('assistant')]),
  ).toBe(false)
  expect(
    hasPendingAssistantTurn([
      message('assistant'),
      message('user', { toolUseResult: {} }),
    ]),
  ).toBe(false)
  expect(
    hasPendingAssistantTurn([message('user'), message('system')]),
  ).toBe(false)
})
