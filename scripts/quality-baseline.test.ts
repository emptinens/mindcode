import { describe, expect, test } from 'bun:test'
import {
  countDiagnostics,
  diagnosticsHash,
  normalizeDiagnostics,
  normalizeGitHubAnnotations,
} from './quality-baseline.mjs'

describe('quality baseline normalization', () => {
  test('keeps every TypeScript diagnostic and removes only the summary', () => {
    const diagnostics = normalizeDiagnostics(
      'typecheck',
      '/workspace/src/a.ts(1,2): error TS2322: bad\n  detail\n\nFound 1 error.\n',
    )
    expect(diagnostics).toEqual(['/workspace/src/a.ts(1,2): error TS2322: bad\n  detail'])
    expect(countDiagnostics('typecheck', diagnostics)).toBe(1)
  })

  test('parses only GitHub annotation lines and excludes stderr summaries', () => {
    const diagnostics = normalizeDiagnostics(
      'lint',
      'Checked 1 file\n::error title=lint/style/noAny,file=src/a.ts,line=2,endLine=2,col=1,endColumn=4::Unexpected any.\n',
      'lint ━━━━━\n  × Some errors were emitted while running checks.\n',
    )
    expect(diagnostics).toEqual([
      '{"level":"error","properties":{"col":"1","endColumn":"4","endLine":"2","file":"src/a.ts","line":"2","title":"lint/style/noAny"},"message":"Unexpected any."}',
    ])
    expect(countDiagnostics('lint', diagnostics)).toBe(1)
  })

  test('normalizes paths, escaped values, and newline variants', () => {
    const first = normalizeGitHubAnnotations(
      '::warning file=./src\\a.ts,line=4,title=lint%2Fstyle%2Ffoo::first%0Asecond\r\n',
    )
    const second = normalizeGitHubAnnotations(
      '::warning title=lint%2Fstyle%2Ffoo,file=src/a.ts,line=4::first%0Asecond\n',
    )
    expect(first).toEqual(second)
    expect(first[0]).toContain('"file":"src/a.ts"')
    expect(first[0]).toContain('first\\nsecond')
  })

  test('produces the same hash for reordered annotations', () => {
    const first = normalizeGitHubAnnotations(
      '::error file=src/b.ts,line=2::b\n::warning file=src/a.ts,line=1::a\n',
    )
    const second = normalizeGitHubAnnotations(
      '::warning file=src/a.ts,line=1::a\n::error file=src/b.ts,line=2::b\n',
    )
    expect(countDiagnostics('lint', first)).toBe(2)
    expect(diagnosticsHash(first)).toBe(diagnosticsHash(second))
  })

  test('sorts diagnostics before hashing deterministically', () => {
    expect(diagnosticsHash(['a', 'b'])).toBe(diagnosticsHash(['a', 'b']))
    expect(diagnosticsHash(['a', 'b'])).toBe(diagnosticsHash(['b', 'a']))
  })
})
