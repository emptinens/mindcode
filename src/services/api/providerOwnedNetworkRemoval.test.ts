import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const sourceRoot = join(import.meta.dir, '../..')

describe('provider-owned network paths', () => {
  test('removed modules are not present in the source tree', () => {
    expect(existsSync(join(sourceRoot, 'services/api/filesApi.ts'))).toBe(false)
    const proxyDirectory = join(sourceRoot, 'upstreamproxy')
    expect(
      !existsSync(proxyDirectory) || readdirSync(proxyDirectory).length === 0,
    ).toBe(true)
    expect(existsSync(join(sourceRoot, 'utils/multiAccount.ts'))).toBe(false)
  })
})
