import { describe, expect, test } from 'bun:test'
import {
  calculateAutoCompactThreshold,
  calculateHardLimitThreshold,
  calculateWarningThreshold,
  isAutoCompactThresholdReached,
  resolveAutoCompactPercentage,
} from './autoCompactPolicy.js'

describe('auto compact policy', () => {
  test('uses 95% for auto/hard and 85% for warning', () => {
    expect(calculateAutoCompactThreshold(1_030_000)).toBe(978_500)
    expect(calculateWarningThreshold(1_030_000)).toBe(875_500)
    expect(calculateHardLimitThreshold(1_030_000)).toBe(978_500)
  })

  test('honors valid overrides and rejects invalid values', () => {
    expect(calculateAutoCompactThreshold(100_000, '94')).toBe(94_000)
    expect(calculateAutoCompactThreshold(100_000, '96')).toBe(96_000)
    expect(resolveAutoCompactPercentage('0')).toBe(95)
    expect(resolveAutoCompactPercentage('101')).toBe(95)
    expect(resolveAutoCompactPercentage('invalid')).toBe(95)
    expect(resolveAutoCompactPercentage('NaN')).toBe(95)
    expect(resolveAutoCompactPercentage('-1')).toBe(95)
  })

  test('compacts at the threshold, not one token later', () => {
    expect(isAutoCompactThresholdReached(84_999, 85_000)).toBe(false)
    expect(isAutoCompactThresholdReached(85_000, 85_000)).toBe(true)
    expect(isAutoCompactThresholdReached(85_001, 85_000)).toBe(true)
  })
})
