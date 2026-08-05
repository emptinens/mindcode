import { describe, expect, test } from 'bun:test'
import { subprocessEnv } from './subprocessEnv.js'

describe('Vexzy subprocess environment wiring', () => {
  test('preserves VEXZY_API_KEY when subprocess scrubbing is enabled', () => {
    const previousKey = process.env.VEXZY_API_KEY
    const previousScrub = process.env.MINDCODE_SUBPROCESS_ENV_SCRUB

    process.env.VEXZY_API_KEY = 'forge-worker-key'
    process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = '1'

    try {
      expect(subprocessEnv().VEXZY_API_KEY).toBe('forge-worker-key')
    } finally {
      if (previousKey === undefined) {
        Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
      } else {
        process.env.VEXZY_API_KEY = previousKey
      }
      if (previousScrub === undefined) {
        Reflect.deleteProperty(
          process.env,
          'MINDCODE_SUBPROCESS_ENV_SCRUB',
        )
      } else {
        process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = previousScrub
      }
    }
  })

  test('scrubs provider-shaped credentials without a provider allowlist', () => {
    const legacyApiKey = ['ANTHROPIC', 'API_KEY'].join('_')
    const legacyToken = ['ANTHROPIC', 'AUTH_TOKEN'].join('_')
    const cloudSecret = ['AWS', 'SECRET_ACCESS_KEY'].join('_')
    const previous = Object.fromEntries(
      [legacyApiKey, legacyToken, cloudSecret, 'GITHUB_TOKEN'].map(key => [
        key,
        process.env[key],
      ]),
    ) as Record<string, string | undefined>
    const previousScrub = process.env.MINDCODE_SUBPROCESS_ENV_SCRUB

    process.env[legacyApiKey] = 'legacy-key'
    process.env[legacyToken] = 'legacy-token'
    process.env[cloudSecret] = 'legacy-secret'
    process.env.GITHUB_TOKEN = 'job-token'
    process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = '1'

    try {
      const env = subprocessEnv()
      expect(env[legacyApiKey]).toBeUndefined()
      expect(env[legacyToken]).toBeUndefined()
      expect(env[cloudSecret]).toBeUndefined()
      expect(env.GITHUB_TOKEN).toBe('job-token')
      expect(env.VEXZY_API_KEY).toBe(process.env.VEXZY_API_KEY)
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
      if (previousScrub === undefined) {
        Reflect.deleteProperty(process.env, 'MINDCODE_SUBPROCESS_ENV_SCRUB')
      } else {
        process.env.MINDCODE_SUBPROCESS_ENV_SCRUB = previousScrub
      }
    }
  })
})
