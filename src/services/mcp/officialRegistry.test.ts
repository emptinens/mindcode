import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  isOfficialMcpUrl,
  prefetchOfficialMcpUrls,
  resetOfficialMcpUrlsForTesting,
} from './officialRegistry.js'

const source = readFileSync(new URL('./officialRegistry.ts', import.meta.url), 'utf8')

describe('VEXZY MCP registry compatibility', () => {
  test('does not contain a network client or Anthropic registry endpoint', () => {
    expect(source).not.toContain("from 'axios'")
    expect(source).not.toContain('api.anthropic.com/mcp-registry')
    expect(source).not.toContain('fetch(')
  })

  test('keeps the compatibility API deterministic and fail-closed', async () => {
    resetOfficialMcpUrlsForTesting()
    await prefetchOfficialMcpUrls()

    expect(isOfficialMcpUrl('https://example.com/mcp')).toBe(false)
    expect(isOfficialMcpUrl('https://api.anthropic.com/mcp-registry')).toBe(false)
  })
})
