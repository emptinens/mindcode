import { afterEach, describe, expect, mock, test } from 'bun:test'
import { VexzyConfigurationError } from './vexzy/errors.js'
import type { VexzyFetch } from './vexzy/messagesClient.js'

Object.assign(globalThis, { MACRO: { VERSION: 'test' } })

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { getVexzyClient } = await import('./client.js')

const withFetchPreconnect = (
  handler: VexzyFetch,
): typeof globalThis.fetch =>
  Object.assign(handler, { preconnect: globalThis.fetch.preconnect })

const ENV_KEYS = [
  'VEXZY_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',
  'MINDCODE_USE_BEDROCK',
  'MINDCODE_USE_VERTEX',
  'MINDCODE_USE_FOUNDRY',
  'API_TIMEOUT_MS',
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

const message = () => ({
  id: 'msg_vexzy_test',
  type: 'message',
  role: 'assistant',
  content: [],
  model: 'gpt-5.6-luna',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
})

describe('Vexzy-native API client wiring', () => {
  test('uses the fixed Vexzy endpoint, Bearer auth, and request metadata', async () => {
    process.env.VEXZY_API_KEY = 'forge-client-key'
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    process.env.ANTHROPIC_CUSTOM_HEADERS = 'x-api-key: custom-legacy-key'
    process.env.MINDCODE_USE_BEDROCK = '1'
    process.env.MINDCODE_USE_VERTEX = '1'
    process.env.MINDCODE_USE_FOUNDRY = '1'

    let capturedRequest:
      | { input: RequestInfo | URL; init?: RequestInit }
      | undefined
    const client = await getVexzyClient({
      maxRetries: 0,
      source: 'client-test',
      fetchOverride: withFetchPreconnect(async (input, init) => {
        capturedRequest = { input, init }
        return new Response(JSON.stringify(message()), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
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
    expect(headers.get('x-app')).toBe('cli')
    expect(headers.get('x-mindcode-session-id')).toBeString()
    expect(headers.get('x-client-request-id')).toBeString()
  })

  test('caller request headers cannot replace Vexzy Authorization', async () => {
    process.env.VEXZY_API_KEY = 'forge-client-key'
    let capturedHeaders: Headers | undefined
    const client = await getVexzyClient({
      maxRetries: 0,
      fetchOverride: withFetchPreconnect(async (_input, init) => {
        capturedHeaders = new Headers(init?.headers)
        return new Response(JSON.stringify(message()), { status: 200 })
      }),
    })

    await client.messages.create(
      {
        model: 'gpt-5.6-luna',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
      },
      { headers: { Authorization: 'Bearer caller-value', 'x-api-key': 'legacy' } },
    )

    expect(capturedHeaders?.get('authorization')).toBe('Bearer forge-client-key')
    expect(capturedHeaders?.has('x-api-key')).toBe(false)
  })

  test('uses an explicit Vexzy key for credential verification', async () => {
    process.env.VEXZY_API_KEY = 'forge-environment-key'
    let authorization: string | null = null
    const client = await getVexzyClient({
      apiKey: 'forge-explicit-key',
      maxRetries: 0,
      fetchOverride: withFetchPreconnect(async (_input, init) => {
        authorization = new Headers(init?.headers).get('authorization')
        return new Response(JSON.stringify(message()), { status: 200 })
      }),
    })

    await client.messages.create({
      model: 'gpt-5.6-luna',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    })
    expect(authorization as string | null).toBe('Bearer forge-explicit-key')
  })

  test('fails closed when VEXZY_API_KEY is absent', async () => {
    Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
    let fetchCalled = false

    await expect(
      getVexzyClient({
        maxRetries: 0,
        apiKey: 'legacy-anthropic-key',
        fetchOverride: withFetchPreconnect(async () => {
          fetchCalled = true
          return new Response('{}')
        }),
      }),
    ).rejects.toBeInstanceOf(VexzyConfigurationError)
    expect(fetchCalled).toBe(false)
  })

  test('fails closed when VEXZY_API_KEY is invalid and does not use legacy providers', async () => {
    process.env.VEXZY_API_KEY = 'invalid-vexzy-key'
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    process.env.MINDCODE_USE_BEDROCK = '1'
    process.env.MINDCODE_USE_VERTEX = '1'
    process.env.MINDCODE_USE_FOUNDRY = '1'
    let fetchCalled = false

    await expect(
      getVexzyClient({
        maxRetries: 0,
        fetchOverride: withFetchPreconnect(async () => {
          fetchCalled = true
          return new Response('{}')
        }),
      }),
    ).rejects.toBeInstanceOf(VexzyConfigurationError)
    expect(fetchCalled).toBe(false)
  })


  test('passes maxRetries to the native adapter', async () => {
    process.env.VEXZY_API_KEY = 'forge-client-key'
    let requests = 0
    const client = await getVexzyClient({
      maxRetries: 0,
      fetchOverride: withFetchPreconnect(async () => {
        requests += 1
        return new Response('{}', { status: 503 })
      }),
    })

    await expect(
      client.messages.create({
        model: 'gpt-5.6-luna',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }],
      }),
    ).rejects.toMatchObject({ status: 503 })
    expect(requests).toBe(1)
  })

  test('passes API_TIMEOUT_MS to the native adapter', async () => {
    process.env.VEXZY_API_KEY = 'forge-client-key'
    process.env.API_TIMEOUT_MS = '1234'
    let seenSignal: AbortSignal | null | undefined
    const client = await getVexzyClient({
      maxRetries: 0,
      fetchOverride: withFetchPreconnect(async (_input, init) => {
        seenSignal = init?.signal
        return new Response(JSON.stringify(message()), { status: 200 })
      }),
    })

    await client.messages.create({
      model: 'gpt-5.6-luna',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }],
    })
    expect(seenSignal).toBeInstanceOf(AbortSignal)
  })
})
