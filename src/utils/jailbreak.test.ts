import { afterEach, describe, expect, test } from 'bun:test'
import {
  JAILBREAK_LEVEL_ENV_VAR,
  getJailbreakLevel,
  getJailbreakLevelFromEnvironment,
  parseJailbreakLevel,
} from './jailbreak.js'

const originalEnvironmentValue = process.env[JAILBREAK_LEVEL_ENV_VAR]

afterEach(() => {
  if (originalEnvironmentValue === undefined) {
    Reflect.deleteProperty(process.env, JAILBREAK_LEVEL_ENV_VAR)
  } else {
    process.env[JAILBREAK_LEVEL_ENV_VAR] = originalEnvironmentValue
  }
})

describe('jailbreak level propagation', () => {
  test('normalizes supported levels and legacy boolean values', () => {
    expect(parseJailbreakLevel(' FULL ')).toBe('full')
    expect(parseJailbreakLevel('Lowered')).toBe('lowered')
    expect(parseJailbreakLevel('TRUE')).toBe('full')
    expect(parseJailbreakLevel('false')).toBe('disabled')
  })

  test('reads and normalizes the worker environment value', () => {
    expect(
      getJailbreakLevelFromEnvironment({
        [JAILBREAK_LEVEL_ENV_VAR]: '  FULL\n',
      }),
    ).toBe('full')
  })

  test('uses the normalized environment value when building worker prompts', () => {
    process.env[JAILBREAK_LEVEL_ENV_VAR] = ' LOWERED '

    expect(getJailbreakLevel()).toBe('lowered')
  })

  test('rejects invalid environment values instead of forwarding them', () => {
    const secret = 'forge-secret; touch /tmp/leaked'
    expect(
      getJailbreakLevelFromEnvironment({
        [JAILBREAK_LEVEL_ENV_VAR]: secret,
      }),
    ).toBeUndefined()
  })
})
