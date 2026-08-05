import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('bun:bundle', () => ({ feature: () => false }))
mock.module('src/bootstrap/state.js', () => ({
  getSdkBetas: () => [],
  markPostCompaction: () => undefined,
}))
mock.module('../../bootstrap/state.js', () => ({
  getSdkBetas: () => [],
  markPostCompaction: () => undefined,
}))
mock.module('../../utils/config.js', () => ({
  getGlobalConfig: () => ({ autoCompactEnabled: true }),
}))
mock.module('../../utils/context.js', () => ({
  COMPACT_MAX_OUTPUT_TOKENS: 20_000,
  getContextWindowForModel: () => 1_050_000,
}))
mock.module('../../utils/debug.js', () => ({
  logForDebugging: () => undefined,
}))
mock.module('../../utils/envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === '1' || value?.toLowerCase() === 'true',
}))
mock.module('../../utils/errors.js', () => ({
  hasExactErrorMessage: () => false,
}))
mock.module('../../utils/log.js', () => ({ logError: () => undefined }))
mock.module('../../utils/tokens.js', () => ({
  tokenCountWithEstimation: () => 0,
}))
mock.module('../analytics/growthbook.js', () => ({
  getFeatureValue_CACHED_MAY_BE_STALE: () => false,
}))
mock.module('../api/claude.js', () => ({
  getMaxOutputTokensForModel: () => 128_000,
}))
mock.module('../api/promptCacheBreakDetection.js', () => ({
  notifyCompaction: () => undefined,
}))
mock.module('../SessionMemory/sessionMemoryUtils.js', () => ({
  setLastSummarizedMessageId: () => undefined,
}))
mock.module('./compact.js', () => ({
  compactConversation: async () => undefined,
  ERROR_MESSAGE_USER_ABORT: 'API Error: Request was aborted.',
}))
mock.module('./postCompactCleanup.js', () => ({
  runPostCompactCleanup: () => undefined,
}))
mock.module('./sessionMemoryCompact.js', () => ({
  trySessionMemoryCompaction: async () => undefined,
}))

const {
  calculateTokenWarningState,
  getAutoCompactThreshold,
  getEffectiveContextWindowSize,
} = await import('./autoCompact.js')

const originalAutoCompactOverride =
  process.env.MINDCODE_AUTOCOMPACT_PCT_OVERRIDE
const originalAutoCompactWindow = process.env.MINDCODE_AUTO_COMPACT_WINDOW
const originalBlockingOverride =
  process.env.MINDCODE_BLOCKING_LIMIT_OVERRIDE

afterEach(() => {
  restoreEnv(
    'MINDCODE_AUTOCOMPACT_PCT_OVERRIDE',
    originalAutoCompactOverride,
  )
  restoreEnv('MINDCODE_AUTO_COMPACT_WINDOW', originalAutoCompactWindow)
  restoreEnv('MINDCODE_BLOCKING_LIMIT_OVERRIDE', originalBlockingOverride)
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    clearEnv(name)
  } else {
    process.env[name] = value
  }
}

function clearEnv(name: string): void {
  Reflect.deleteProperty(process.env, name)
}

describe('auto compact thresholds', () => {
  test('uses Luna effective context of 1,030,000 tokens', () => {
    clearEnv('MINDCODE_AUTO_COMPACT_WINDOW')
    expect(getEffectiveContextWindowSize('gpt-5.6-luna')).toBe(1_030_000)
  })

  test('warns at 85% and auto-compacts/blocks at 95%', () => {
    clearEnv('MINDCODE_AUTOCOMPACT_PCT_OVERRIDE')
    clearEnv('MINDCODE_BLOCKING_LIMIT_OVERRIDE')

    expect(getAutoCompactThreshold('gpt-5.6-luna')).toBe(978_500)

    expect(calculateTokenWarningState(875_499, 'gpt-5.6-luna')).toMatchObject({
      isAboveWarningThreshold: false,
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: false,
    })
    expect(calculateTokenWarningState(875_500, 'gpt-5.6-luna')).toMatchObject({
      isAboveWarningThreshold: true,
      isAboveAutoCompactThreshold: false,
      isAtBlockingLimit: false,
    })
    expect(calculateTokenWarningState(978_500, 'gpt-5.6-luna')).toMatchObject({
      isAboveWarningThreshold: true,
      isAboveErrorThreshold: true,
      isAboveAutoCompactThreshold: true,
      isAtBlockingLimit: true,
    })
  })

  test('validates the auto-compact percentage override', () => {
    process.env.MINDCODE_AUTOCOMPACT_PCT_OVERRIDE = '90'
    expect(getAutoCompactThreshold('gpt-5.6-luna')).toBe(927_000)

    process.env.MINDCODE_AUTOCOMPACT_PCT_OVERRIDE = '101'
    expect(getAutoCompactThreshold('gpt-5.6-luna')).toBe(978_500)
  })
})
