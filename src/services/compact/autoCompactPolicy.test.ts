import { describe, expect, test } from 'bun:test'
import {
  calculateAutoCompactThreshold,
  isAutoCompactThresholdReached,
  resolveAutoCompactPercentage,
} from './autoCompactPolicy.js'

describe('auto compact policy', () => {
  test('defaults to exactly 85% of the effective context window', () => {
    expect(calculateAutoCompactThreshold(980_000)).toBe(833_000)
  })

  test('honors valid overrides and rejects invalid values', () => {
    expect(calculateAutoCompactThreshold(100_000, '84')).toBe(84_000)
    expect(calculateAutoCompactThreshold(100_000, '86')).toBe(86_000)
    expect(resolveAutoCompactPercentage('0')).toBe(85)
    expect(resolveAutoCompactPercentage('101')).toBe(85)
    expect(resolveAutoCompactPercentage('invalid')).toBe(85)
  })

  test('compacts at the threshold, not one token later', () => {
    expect(isAutoCompactThresholdReached(84_999, 85_000)).toBe(false)
    expect(isAutoCompactThresholdReached(85_000, 85_000)).toBe(true)
    expect(isAutoCompactThresholdReached(85_001, 85_000)).toBe(true)
  })
})
