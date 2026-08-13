import { describe, expect, test } from 'bun:test'
import {
  VEXZY_ENDPOINTS,
  VEXZY_MESSAGES_ENDPOINT,
  VEXZY_MESSAGES_BASE_URL,
  VEXZY_OPENAI_BASE_URL,
  createVexzyConfig,
  getVexzyApiKey,
  isVexzyApiKey,
  requireVexzyApiKey,
} from './config.js'

describe('Vexzy configuration', () => {
  test('uses the fixed OpenAI-compatible and messages endpoints', () => {
    expect(VEXZY_OPENAI_BASE_URL).toBe('https://api.echogate.one/v1')
    expect(VEXZY_MESSAGES_BASE_URL).toBe('https://api.echogate.one')
    expect(VEXZY_ENDPOINTS.chatCompletions).toBe(
      'https://api.echogate.one/v1/chat/completions',
    )
    expect(VEXZY_ENDPOINTS.models).toBe('https://api.echogate.one/v1/models')
    expect(VEXZY_MESSAGES_ENDPOINT).toBe(
      'https://api.echogate.one/v1/messages',
    )
  })

  test('accepts only forge-prefixed non-whitespace keys', () => {
    expect(isVexzyApiKey('forge-test-key')).toBe(true)
    expect(isVexzyApiKey('test-key')).toBe(false)
    expect(isVexzyApiKey('forge-')).toBe(false)
    expect(isVexzyApiKey('forge-test key')).toBe(false)
  })

  test('resolves the key without putting it in validation errors', () => {
    const apiKey = 'forge-test-key'
    expect(getVexzyApiKey({ VEXZY_API_KEY: apiKey })).toBe(apiKey)
    expect(requireVexzyApiKey({ VEXZY_API_KEY: apiKey })).toBe(apiKey)
    expect(() => requireVexzyApiKey({ VEXZY_API_KEY: 'bad' })).toThrow(
      'VEXZY_API_KEY must start with forge-',
    )
    expect(() => createVexzyConfig('bad')).toThrow(
      'VEXZY_API_KEY must start with forge-',
    )
  })
})
