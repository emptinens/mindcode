import { afterEach, describe, expect, mock, test } from 'bun:test'
import { VexzyConfigurationError } from '../services/api/vexzy/errors.js'

Object.assign(globalThis, { MACRO: { VERSION: 'test' } })

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const {
  checkAndRefreshOAuthTokenIfNeeded,
  getAnthropicApiKey,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
} = await import('./auth.js')

const ENV_KEYS = [
  'VEXZY_API_KEY',
  'ANTHROPIC_API_KEY',
  'MINDCODE_OAUTH_TOKEN',
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

describe('Vexzy runtime auth gates', () => {
  test('uses the Vexzy credential and bypasses OAuth behavior', async () => {
    process.env.VEXZY_API_KEY = 'forge-auth-key'
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    process.env.MINDCODE_OAUTH_TOKEN = 'legacy-oauth-token'

    expect(getAnthropicApiKey()).toBe('forge-auth-key')
    expect(isAnthropicAuthEnabled()).toBe(false)
    expect(isClaudeAISubscriber()).toBe(false)
    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(false)
  })

  test.each(['', 'legacy-key', 'forge-', 'forge-key with-space'])(
    'fails closed instead of using legacy auth for %j',
    value => {
      process.env.VEXZY_API_KEY = value
      process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
      process.env.MINDCODE_OAUTH_TOKEN = 'legacy-oauth-token'

      expect(() => getAnthropicApiKey()).toThrow(VexzyConfigurationError)
      expect(() => isAnthropicAuthEnabled()).toThrow(VexzyConfigurationError)
      expect(() => checkAndRefreshOAuthTokenIfNeeded()).toThrow(
        VexzyConfigurationError,
      )
    },
  )

  test('keeps legacy API-key behavior when VEXZY_API_KEY is absent', () => {
    Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
    process.env.ANTHROPIC_API_KEY = 'legacy-anthropic-key'
    Reflect.deleteProperty(process.env, 'MINDCODE_OAUTH_TOKEN')

    expect(getAnthropicApiKey()).toBe('legacy-anthropic-key')
  })
})
