import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const authMock = () => ({
  getAuthTokenSource: () => undefined,
  getAnthropicApiKey: () => null,
  getAnthropicApiKeyWithSource: () => undefined,
  handleOAuth401Error: async () => false,
  getClaudeAIOAuthTokens: () => undefined,
  getOauthAccountInfo: () => undefined,
  getSubscriptionType: () => undefined,
  isClaudeAISubscriber: () => false,
  isMaxSubscriber: () => false,
  isProSubscriber: () => false,
  isTeamPremiumSubscriber: () => false,
})
mock.module('src/utils/auth.js', authMock)
mock.module(
  new URL('../../utils/auth.ts', import.meta.url).pathname,
  authMock,
)

const messagesMock = () => ({
  NO_RESPONSE_REQUESTED: 'NO_RESPONSE_REQUESTED',
  createAssistantAPIErrorMessage: (input: unknown) => ({
    isApiErrorMessage: true,
    message: { content: [input] },
  }),
})
mock.module('src/utils/messages.js', messagesMock)
mock.module(
  new URL('../../utils/messages.ts', import.meta.url).pathname,
  messagesMock,
)

const limitsMock = () => ({
  getRateLimitErrorMessage: () => undefined,
})
mock.module('../vexzyLimits.js', limitsMock)
mock.module(
  new URL('../vexzyLimits.ts', import.meta.url).pathname,
  limitsMock,
)
mock.module('src/services/vexzyLimits.js', limitsMock)

const modelMock = () => ({
  getDefaultMainLoopModelSetting: () => 'sonnet',
  isNonCustomOpusModel: () => false,
})
mock.module('src/utils/model/model.js', modelMock)
mock.module(
  new URL('../../utils/model/model.ts', import.meta.url).pathname,
  modelMock,
)

const modelStringsMock = () => ({
  getModelStrings: () => ({ opus40: 'opus-4-0' }),
})
mock.module('src/utils/model/modelStrings.js', modelStringsMock)
mock.module(
  new URL('../../utils/model/modelStrings.ts', import.meta.url).pathname,
  modelStringsMock,
)

const { getAssistantMessageFromError } = await import('./errors.js')

describe('model environment error guidance', () => {
  test('guides Ant users to MINDCODE_MODEL', () => {
    const previousUserType = process.env.USER_TYPE
    const previousModel = process.env.MINDCODE_MODEL
    const previousLegacyModel = process.env.ANTHROPIC_MODEL
    const previousMacro = (globalThis as { MACRO?: unknown }).MACRO

    try {
      process.env.USER_TYPE = 'ant'
      delete process.env.MINDCODE_MODEL
      delete process.env.ANTHROPIC_MODEL
      ;(globalThis as { MACRO?: { FEEDBACK_CHANNEL: string } }).MACRO = {
        FEEDBACK_CHANNEL: 'feedback',
      }

      const message = getAssistantMessageFromError(
        new Error('invalid model name'),
        'custom-model',
      )
      const content = JSON.stringify(message.message.content)

      expect(content).toContain('MINDCODE_MODEL=')
      expect(content).not.toContain('ANTHROPIC_MODEL=')
    } finally {
      if (previousUserType === undefined) delete process.env.USER_TYPE
      else process.env.USER_TYPE = previousUserType
      if (previousModel === undefined) delete process.env.MINDCODE_MODEL
      else process.env.MINDCODE_MODEL = previousModel
      if (previousLegacyModel === undefined)
        delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousLegacyModel
      if (previousMacro === undefined) delete (globalThis as { MACRO?: unknown }).MACRO
      else (globalThis as { MACRO?: unknown }).MACRO = previousMacro
    }
  })
})
