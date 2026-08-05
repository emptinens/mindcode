import { describe, expect, test } from 'bun:test'
import {
  VEXZY_BASE_URL,
  getAPIProvider,
  getAPIProviderForStatsig,
  getVexzyRuntimeApiKey,
  isVexzyMode,
} from './providers.js'
import { VexzyConfigurationError } from '../../services/api/vexzy/errors.js'

describe('Vexzy runtime provider wiring', () => {
  test('recognizes forge-prefixed runtime credentials', () => {
    expect(getVexzyRuntimeApiKey({ VEXZY_API_KEY: 'forge-test-key' })).toBe(
      'forge-test-key',
    )
    expect(isVexzyMode({ VEXZY_API_KEY: 'forge-test-key' })).toBe(true)
    expect(getVexzyRuntimeApiKey({})).toBeUndefined()
    expect(isVexzyMode({})).toBe(true)
  })

  test.each(['', 'legacy-key', 'forge-', 'forge-key with-space'])(
    'fails closed for a present invalid credential: %j',
    value => {
      expect(() => getVexzyRuntimeApiKey({ VEXZY_API_KEY: value })).toThrow(
        VexzyConfigurationError,
      )
      expect(() => isVexzyMode({ VEXZY_API_KEY: value })).toThrow(
        VexzyConfigurationError,
      )
    },
  )

  test('uses the fixed Vexzy messages base URL', () => {
    expect(VEXZY_BASE_URL).toBe('https://api.echogate.one')
  })

  test('resolves only the Vexzy runtime provider', () => {
    const env = {
      VEXZY_API_KEY: 'forge-test-key',
      MINDCODE_USE_BEDROCK: '1',
      MINDCODE_USE_VERTEX: '1',
      MINDCODE_USE_FOUNDRY: '1',
    }

    expect(getAPIProvider(env)).toBe('vexzy')
    expect(getAPIProviderForStatsig(env)).toBe('vexzy')
  })

  test('fails closed when the runtime credential is missing', () => {
    expect(() => getAPIProvider({})).toThrow(VexzyConfigurationError)
    expect(() => getAPIProviderForStatsig({})).toThrow(
      VexzyConfigurationError,
    )
  })

  test.each([
    { MINDCODE_USE_BEDROCK: '1' },
    { MINDCODE_USE_VERTEX: '1' },
    { MINDCODE_USE_FOUNDRY: '1' },
  ])('does not fall back to a legacy provider: %j', env => {
    expect(() => getAPIProvider(env)).toThrow(VexzyConfigurationError)
  })

})
