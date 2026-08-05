import { describe, expect, mock, test } from 'bun:test'

const errorsMock = () => ({ classifyAPIError: () => 'unknown' })
mock.module('./errors.js', errorsMock)
mock.module(new URL('./errors.ts', import.meta.url).pathname, errorsMock)

const metadataMock = () => ({
  sanitizeToolNameForAnalytics: (name: string) => name,
})
mock.module('../analytics/metadata.js', metadataMock)
mock.module(
  new URL('../analytics/metadata.ts', import.meta.url).pathname,
  metadataMock,
)

const tracingMock = () => ({
  endLLMRequestSpan: () => undefined,
  isBetaTracingEnabled: () => false,
})
mock.module('src/utils/telemetry/sessionTracing.js', tracingMock)
mock.module(
  new URL('../../utils/telemetry/sessionTracing.ts', import.meta.url).pathname,
  tracingMock,
)

const { getAnthropicEnvMetadata } = await import('./logging.js')

describe('API environment logging', () => {
  test('records MINDCODE_MODEL as the configured model environment', () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousLegacyModel = process.env.ANTHROPIC_MODEL

    try {
      process.env.MINDCODE_MODEL = 'sonnet'
      process.env.ANTHROPIC_MODEL = 'opus'

      expect(getAnthropicEnvMetadata()).toMatchObject({ envModel: 'sonnet' })
    } finally {
      if (previousModel === undefined) delete process.env.MINDCODE_MODEL
      else process.env.MINDCODE_MODEL = previousModel
      if (previousLegacyModel === undefined)
        delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousLegacyModel
    }
  })
})
