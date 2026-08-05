import { describe, expect, test } from 'bun:test'
import {
  collectRecentAssistantTexts,
  resolveCopyIndex,
} from './copyLogic.js'

describe('/copy', () => {
  test('returns the latest meaningful assistant messages newest first', () => {
    const messages = [
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'older' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 'tool-1' }] },
      },
      {
        type: 'assistant',
        isApiErrorMessage: true,
        message: { content: [{ type: 'text', text: 'provider error' }] },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'latest' }] },
      },
    ] as never[]

    expect(collectRecentAssistantTexts(messages)).toEqual(['latest', 'older'])
  })

  test('joins streamed text blocks from one assistant response', () => {
    const messages = [
      {
        type: 'assistant',
        uuid: 'part-1',
        message: { id: 'response-1', content: [{ type: 'text', text: 'first' }] },
      },
      {
        type: 'assistant',
        uuid: 'part-2',
        message: { id: 'response-1', content: [{ type: 'text', text: 'second' }] },
      },
    ] as never[]

    expect(collectRecentAssistantTexts(messages)).toEqual(['first\n\nsecond'])
  })

  test('copies string assistant content', () => {
    const messages = [
      {
        type: 'assistant',
        uuid: 'string-response',
        message: { content: 'plain response' },
      },
    ] as never[]

    expect(collectRecentAssistantTexts(messages)).toEqual(['plain response'])
  })

  test('selects the latest by default and supports one-based history', () => {
    expect(resolveCopyIndex('', 3)).toEqual({ index: 0 })
    expect(resolveCopyIndex('2', 3)).toEqual({ index: 1 })
  })

  test('rejects invalid and unavailable history indexes', () => {
    expect(resolveCopyIndex('0', 2)).toHaveProperty('error')
    expect(resolveCopyIndex('1.5', 2)).toHaveProperty('error')
    expect(resolveCopyIndex('3', 2)).toHaveProperty('error')
  })
})
