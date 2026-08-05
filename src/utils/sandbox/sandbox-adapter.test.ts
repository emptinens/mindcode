import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./sandbox-adapter.ts', import.meta.url), 'utf8')

describe('local sandbox adapter', () => {
  test('uses a local contract instead of a removed vendor runtime', () => {
    expect(source).toContain('export class SandboxViolationStore')
    expect(source).toContain('const BaseSandboxManager =')
    expect(source).toContain('native sandbox backend is unavailable')
    expect(source).not.toContain('@anthropic-ai/' + 'mcpb')
    expect(source).not.toContain('@anthropic-ai/' + 'sandbox-runtime')
  })

  test('keeps filesystem and network config mappings', () => {
    expect(source).toContain('allowOnly: activeRuntimeConfig.filesystem.allowWrite')
    expect(source).toContain('allowedHosts: activeRuntimeConfig.network.allowedDomains')
    expect(source).toContain('async wrapWithSandbox(')
  })
})
