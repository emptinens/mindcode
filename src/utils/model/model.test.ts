import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { getMainLoopModelOverride, setMainLoopModelOverride } = await import(
  '../../bootstrap/state.js'
)
const { getUserSpecifiedModelSetting } = await import('./model.js')

describe('model environment selection', () => {
  test('prefers MINDCODE_MODEL over the legacy environment variable', () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousLegacyModel = process.env.ANTHROPIC_MODEL
    const previousOverride = getMainLoopModelOverride()

    try {
      setMainLoopModelOverride(undefined)
      process.env.MINDCODE_MODEL = 'sonnet'
      process.env.ANTHROPIC_MODEL = 'opus'

      expect(getUserSpecifiedModelSetting()).toBe('sonnet')
    } finally {
      setMainLoopModelOverride(previousOverride)
      if (previousModel === undefined) delete process.env.MINDCODE_MODEL
      else process.env.MINDCODE_MODEL = previousModel
      if (previousLegacyModel === undefined)
        delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousLegacyModel
    }
  })
})
