import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (relativePath: string): string =>
  readFileSync(resolve(root, relativePath), 'utf8')

describe('VEXZY provider OAuth cleanup', () => {
  test('removes the provider OAuth implementation files', () => {
    const oauthDir = resolve(root, 'src/services/oauth')
    if (!existsSync(oauthDir)) return
    expect(
      readdirSync(oauthDir).filter(file => /\.(?:ts|tsx)$/.test(file)),
    ).toEqual([])
  })

  test('retains only VEXZY endpoint configuration', () => {
    const source = read('src/constants/oauth.ts')
    expect(source).toContain('VEXZY_MESSAGES_BASE_URL')
    expect(source).toContain('OAuthConfig')
    for (const forbidden of [
      'OAuthCompatibilityConfig',
      'CLAUDE_AI_',
      'CLAUDEAI_',
      'ANTHROPIC_',
    ]) {
      expect(source).not.toContain(forbidden)
    }
    expect(source).not.toContain('MCP_CLIENT_METADATA_URL')
    expect(source).not.toContain('api.anthropic.com')
    expect(source).not.toContain('claude.ai/oauth')
    expect(source).not.toContain('platform.claude.com')
    expect(source).not.toContain('process.env.USER_TYPE')
    expect(source).not.toContain('MINDCODE_CUSTOM_OAUTH_URL')
    expect(source).not.toContain('MINDCODE_OAUTH_CLIENT_ID')
  })

  test('keeps local MCP OAuth and secure storage ownership isolated', () => {
    const mcpAuth = read('src/services/mcp/auth.ts')
    const mcpPort = read('src/services/mcp/oauthPort.ts')
    const secureStorage = read('src/utils/secureStorage/types.ts')

    expect(mcpAuth).toContain('performMCPOAuthFlow')
    expect(mcpAuth).toContain('@modelcontextprotocol/sdk')
    expect(mcpAuth).toContain('getSecureStorage')
    expect(mcpAuth).not.toContain('../../constants/oauth.js')
    expect(mcpAuth).not.toContain('MCP_CLIENT_METADATA_URL')
    expect(mcpPort).toContain('buildRedirectUri')
    expect(secureStorage).toContain('mcpOAuth?:')
  })

  test('does not leave source imports into the removed OAuth service', () => {
    const sourceFiles = [
      'src',
    ]
    const forbidden = /services\/oauth\/(?:auth-code-listener|client|crypto|getOauthProfile|index)\.js/
    const stack = [...sourceFiles.map(relative => resolve(root, relative))]
    const matches: string[] = []

    while (stack.length > 0) {
      const current = stack.pop()!
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const path = resolve(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(path)
        } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
          const text = readFileSync(path, 'utf8').split('//# sourceMappingURL=', 1)[0]
          if (forbidden.test(text)) matches.push(path)
        }
      }
    }

    expect(matches).toEqual([])
  })
})
