import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('./config.js', () => ({
  getGlobalConfig: () => ({}),
}))
mock.module('./envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === '1' || value?.toLowerCase() === 'true',
}))
mock.module('./model/model.js', () => ({
  getCanonicalName: (model: string) => model.toLowerCase(),
}))
mock.module('./model/modelCapabilities.js', () => ({
  getModelCapability: () => undefined,
}))

const {
  getContextWindowForModel,
  modelSupports1M,
  VEXZY_LUNA_CONTEXT_WINDOW,
} = await import('./context.js')

const originalDisable1m = process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT
const originalUserType = process.env.USER_TYPE

afterEach(() => {
  if (originalDisable1m === undefined) {
    clearEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT')
  } else {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = originalDisable1m
  }
  if (originalUserType === undefined) {
    clearEnv('USER_TYPE')
  } else {
    process.env.USER_TYPE = originalUserType
  }
})

function clearEnv(name: string): void {
  Reflect.deleteProperty(process.env, name)
}

describe('context windows', () => {
  test('uses the native 1,050,000-token context for Vexzy Luna', () => {
    clearEnv('CLAUDE_CODE_DISABLE_1M_CONTEXT')
    clearEnv('USER_TYPE')

    expect(VEXZY_LUNA_CONTEXT_WINDOW).toBe(1_050_000)
    expect(getContextWindowForModel('gpt-5.6-luna')).toBe(1_050_000)
    expect(getContextWindowForModel('gpt-5.6-luna[1m]')).toBe(1_050_000)
  })

  test('does not downgrade Vexzy Luna when legacy Claude 1M is disabled', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = 'true'
    clearEnv('USER_TYPE')

    expect(getContextWindowForModel('gpt-5.6-luna')).toBe(1_050_000)
    expect(modelSupports1M('gpt-5.6-luna')).toBe(true)
    expect(getContextWindowForModel('claude-sonnet-4-6')).toBe(200_000)
  })

  test('keeps explicit 1m suffixes at 1,000,000 for other models', () => {
    process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT = 'true'
    clearEnv('USER_TYPE')

    expect(getContextWindowForModel('custom-model[1m]')).toBe(1_000_000)
    expect(getContextWindowForModel('claude-custom[1m]')).toBe(200_000)
  })
})
