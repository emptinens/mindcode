import { describe, expect, test } from 'bun:test'

describe('bounded CLI branding', () => {
  test('uses VEXZY setup text without the removed browser integration', async () => {
    const files = [
      'src/cli/handlers/util.tsx',
      'src/commands/login/index.ts',
      'src/commands/login/login.tsx',
      'src/commands/logout/index.ts',
      'src/entrypoints/cli.tsx',
    ]

    for (const file of files) {
      const source = await Bun.file(new URL(`../../${file}`, import.meta.url)).text()
      const runtimeSource = source.split('//# sourceMappingURL=', 1)[0]
      expect(runtimeSource).not.toContain('Claude subscription')
      expect(runtimeSource).not.toContain('Anthropic account')
    }

    const setup = await Bun.file(
      new URL('../../src/cli/handlers/util.tsx', import.meta.url),
    ).text()
    expect(setup).toContain('VEXZY_API_KEY')

    const entrypoint = await Bun.file(
      new URL('../../src/entrypoints/cli.tsx', import.meta.url),
    ).text()
    expect(entrypoint).not.toContain('browser-mcp')
    expect(entrypoint).not.toContain('claude-in-chrome-mcp')
  })

  test('keeps CLI authentication and managed MCP paths VEXZY-only', async () => {
    const source = await Bun.file(
      new URL('../../src/main.tsx', import.meta.url),
    ).text()
    const runtimeSource = source.split('//# sourceMappingURL=', 1)[0]

    expect(runtimeSource).toContain(
      "auth.command('login').description('Verify VEXZY_API_KEY authentication')",
    )
    expect(runtimeSource).not.toContain(".option('--sso'")
    expect(runtimeSource).not.toContain(".option('--console'")
    expect(runtimeSource).not.toContain(".option('--claudeai'")
    expect(runtimeSource).not.toContain('fetchClaudeAIMcpConfigsIfEligible')
    expect(runtimeSource).not.toContain('claudeaiConfigPromise')
  })
})
