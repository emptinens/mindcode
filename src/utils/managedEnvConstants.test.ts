import { describe, expect, test } from 'bun:test'
import {
  isProviderManagedEnvVar,
  SAFE_ENV_VARS,
} from './managedEnvConstants.js'

describe('managed model environment variables', () => {
  test('manages and permits MINDCODE_MODEL instead of ANTHROPIC_MODEL', () => {
    expect(isProviderManagedEnvVar('MINDCODE_MODEL')).toBe(true)
    expect(isProviderManagedEnvVar('ANTHROPIC_MODEL')).toBe(false)
    expect(SAFE_ENV_VARS.has('MINDCODE_MODEL')).toBe(true)
    expect(SAFE_ENV_VARS.has('ANTHROPIC_MODEL')).toBe(false)
  })
})
