import { describe, expect, test } from 'bun:test'
import {
  VEXZY_BASE_URL,
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
    expect(isVexzyMode({})).toBe(false)
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
})
