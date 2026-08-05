import { describe, expect, test } from 'bun:test'
import {
  ALLOWLISTED_TARGET_FILES,
  evaluateCoverage,
  formatCoverageReport,
  parseLcov,
} from './coverage-changed.mjs'

const lcov = `TN:
SF:src/utils/effort.ts
DA:1,1
DA:2,0
DA:3,1
LF:3
LH:2
end_of_record
SF:src/legacy/generated.ts
DA:1,0
LF:1
LH:0
end_of_record
`

describe('architectural LCOV gate', () => {
  test('parses LCOV records and normalizes source paths', () => {
    const records = parseLcov(lcov.replace('SF:src/utils/effort.ts', `SF:${process.cwd()}/src/utils/effort.ts`))
    expect(records).toHaveLength(2)
    expect(records[0].file).toBe('src/utils/effort.ts')
    expect(records[0].lineFound).toBe(3)
    expect(records[0].lineHit).toBe(2)
  })

  test('gates only explicit allowlisted files and ignores legacy records', () => {
    const result = evaluateCoverage(parseLcov(lcov), {
      targets: ['src/utils/effort.ts'],
      threshold: 0.66,
    })
    expect(result.passed).toBe(true)
    expect(result.percentage).toBeCloseTo(66.666, 2)
    expect(result.ignoredRecords).toEqual(['src/legacy/generated.ts'])
  })

  test('fails when an allowlisted target has no LCOV record', () => {
    const result = evaluateCoverage(parseLcov(lcov), {
      targets: ['src/utils/effort.ts', 'src/utils/context.ts'],
      threshold: 0.85,
    })
    expect(result.passed).toBe(false)
    expect(result.missing).toEqual(['src/utils/context.ts'])
  })

  test('fails below the threshold and formats an actionable report', () => {
    const result = evaluateCoverage(parseLcov(lcov), {
      targets: ['src/utils/effort.ts'],
      threshold: 0.85,
    })
    expect(result.passed).toBe(false)
    expect(formatCoverageReport(result)).toContain('Required: 85.00%')
    expect(formatCoverageReport(result)).toContain('src/utils/effort.ts')
  })

  test('keeps the production allowlist explicit and non-empty', () => {
    expect(ALLOWLISTED_TARGET_FILES.length).toBeGreaterThan(20)
    expect(new Set(ALLOWLISTED_TARGET_FILES).size).toBe(ALLOWLISTED_TARGET_FILES.length)
    expect(ALLOWLISTED_TARGET_FILES.every(file => file.startsWith('src/'))).toBe(true)
  })
})
