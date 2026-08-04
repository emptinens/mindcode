import { afterEach, describe, expect, mock, test } from 'bun:test'
import { VexzyConfigurationError } from './vexzy/errors.js'

Object.assign(globalThis, { MACRO: { VERSION: 'test' } })

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { getAnthropicClient } = await import('./client.js')

const ENV_KEYS = [
  'VEXZY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
] as const
const originalEnv = Object.fromEntries(
  ENV_KEYS.map(key => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key]
    if (value === undefined) Reflect.deleteProperty(process.env, key)
    else process.env[key] = value
  }
})

describe('Vexzy runtime API client wiring', () => {
  test('sends messages to Vexzy with Bearer auth and no x-api-key', async () => {
    process.env.VEXZY_API_KEY = 'forge-client-key'
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-api-key: custom-legacy-key'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    let capturedRequest:
      | { input: RequestInfo | URL; init?: RequestInit }
      | undefined
    const client = await getAnthropicClient({
      maxRetries: 0,
      fetchOverride: async (input, init) => {
        capturedRequest = { input, init }
        return new Response(
          JSON.stringify({
            id: 'msg_vexzy_test',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'gpt-5.6-luna',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        )
      },
    })

    await client.messages.create({
      model: 'gpt-5.6-luna',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    })

    if (!capturedRequest) throw new Error('Injected fetch was not called')
    const input = capturedRequest.input
    const url = input instanceof Request ? input.url : String(input)
    const headers = new Headers(capturedRequest.init?.headers)
    expect(url).toBe('https://api.echogate.one/v1/messages')
    expect(headers.get('authorization')).toBe('Bearer forge-client-key')
    expect(headers.has('x-api-key')).toBe(false)
  })

  test('rejects an invalid present Vexzy credential before fetching', async () => {
    process.env.VEXZY_API_KEY = 'invalid-vexzy-key'
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    let fetchCalled = false

    await expect(
      getAnthropicClient({
        maxRetries: 0,
        fetchOverride: async () => {
          fetchCalled = true
          return new Response('{}')
        },
      }),
    ).rejects.toBeInstanceOf(VexzyConfigurationError)
    expect(fetchCalled).toBe(false)
  })
})
