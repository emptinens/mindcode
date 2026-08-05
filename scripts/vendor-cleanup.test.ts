import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const files = [
  'src/utils/dxt/helpers.ts',
  'src/utils/dxt/manifest.ts',
  'src/utils/plugins/mcpbHandler.ts',
  'src/utils/plugins/schemas.ts',
  'src/utils/sandbox/sandbox-adapter.ts',
  'src/utils/shell/powershellProvider.ts',
  'scripts/bun-plugin-shims.ts',
  'scripts/build-bundle.mjs',
]

describe('vendor cleanup regression', () => {
  test('build and source scope has no removed vendor imports or shims', () => {
    const source = files.map(file => readFileSync(resolve(root, file), 'utf8')).join('\n')
    expect(source).not.toContain('@anthropic-ai/' + 'mcpb')
    expect(source).not.toContain('@anthropic-ai/' + 'sandbox-runtime')
    expect(source).not.toContain('sandbox-runtime-shim')
  })
})
