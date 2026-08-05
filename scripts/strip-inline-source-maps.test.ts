import { describe, expect, test } from 'bun:test'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const script = resolve(import.meta.dir, 'strip-inline-source-maps.mjs')

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('strip-inline-source-maps', () => {
  test('removes terminal inline maps, preserves source, and is idempotent', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'strip-inline-source-maps-'))
    try {
      const original = 'const value = "data:sourceMappingURL=data:not-a-trailer"\r\n//# sourceMappingURL=data:application/json;base64,AAAA\r\n'
      const ignored = '//# sourceMappingURL=data:ignored\n'
      writeFileSync(join(fixture, 'nested.ts'), original)
      writeFileSync(join(fixture, 'nested.js'), ignored)
      writeFileSync(join(fixture, 'ignored.txt'), '//# sourceMappingURL=data:ignored\n')

      const checkBefore = run('--check', fixture)
      expect(checkBefore.status).toBe(1)
      expect(checkBefore.stdout).toContain('2 trailers')

      const processResult = run(fixture)
      expect(processResult.status).toBe(0)
      expect(processResult.stdout).toContain('2 trailers')
      expect(readFileSync(join(fixture, 'nested.ts'), 'utf8')).toBe('const value = "data:sourceMappingURL=data:not-a-trailer"\r\n')
      expect(readFileSync(join(fixture, 'nested.js'), 'utf8')).toBe('\n')
      expect(readFileSync(join(fixture, 'ignored.txt'), 'utf8')).toBe('//# sourceMappingURL=data:ignored\n')

      const afterFirstRun = readFileSync(join(fixture, 'nested.ts'))
      const secondRun = run(fixture)
      expect(secondRun.status).toBe(0)
      expect(secondRun.stdout).toContain('0 trailers')
      expect(readFileSync(join(fixture, 'nested.ts'))).toEqual(afterFirstRun)
      expect(run('--check', fixture).status).toBe(0)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
