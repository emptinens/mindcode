import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = new URL('../', import.meta.url).pathname

function source(path: string): string {
  return readFileSync(join(sourceRoot, path), 'utf8')
}

const legacyChromeToken = ['claude', 'In', 'Chrome'].join('')
const legacyMcpPackage = ['@ant', 'claude-for-chrome-mcp'].join('/')

const activeRuntimeFiles = [
  'entrypoints/cli.tsx',
  'main.tsx',
  'skills/bundled/index.ts',
  'screens/REPL.tsx',
  'services/mcp/client.ts',
  'services/mcp/config.ts',
  'services/api/modelRuntime.ts',
  'utils/attachments.ts',
  'bootstrap/state.ts',
  'tools/shared/spawnMultiAgent.ts',
  'utils/swarm/spawnUtils.ts',
]

describe('legacy Chrome integration removal', () => {
  test('removes feature modules and command registration targets', () => {
    for (const path of [
      'utils/claudeInChrome',
      'skills/bundled/claudeInChrome.ts',
      'commands/chrome',
      'components/ClaudeInChromeOnboarding.tsx',
      'hooks/useChromeExtensionNotification.tsx',
      'hooks/usePromptsFromClaudeInChrome.tsx',
    ]) {
      expect(existsSync(join(sourceRoot, path))).toBe(false)
    }

    expect(source('commands.ts')).not.toContain("commands/chrome")
  })

  test('active CLI/runtime contains no legacy imports, flags, or registration', () => {
    const runtime = activeRuntimeFiles.map(source).join('\n')
    for (const forbidden of [
      legacyChromeToken,
      legacyMcpPackage,
      'browser-mcp',
      'chrome-native-host',
      '--chrome',
      '--no-chrome',
      'MINDCODE_IN_CHROME',
      'claudeInChromeDefaultEnabled',
      'hasCompletedClaudeInChromeOnboarding',
    ]) {
      expect(runtime).not.toContain(forbidden)
    }
  })

  test('build shims do not recreate the removed package', () => {
    const shims = `${source('../scripts/build-bundle.mjs')}\n${source('../scripts/bun-plugin-shims.ts')}`
    expect(shims).not.toContain(legacyMcpPackage)
    expect(shims).not.toContain('chrome-mcp-shim')
  })
})
