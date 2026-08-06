import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const registry = readFileSync(new URL('../commands.ts', import.meta.url), 'utf8')
const activeRegistry = registry.slice(
  registry.indexOf('const COMMANDS ='),
  registry.indexOf('export const builtInCommandNames'),
)

test('VEXZY builtin registry exposes the active MindCode command surface', () => {
  for (const name of [
    'clear',
    'config',
    'copy',
    'copycon',
    'model',
    'effort',
    'submodel',
    'agents',
    'tasks',
    'compact',
    'status',
    'mcp',
    'skills',
    'jailbreak',
    'login',
    'logout',
    'account',
    'help',
    'permissions',
    'plan',
    'exit',
    'plugin',
    'reloadPlugins',
  ]) {
    expect(activeRegistry).toMatch(new RegExp(`\\n\\s*${name}(?:\\(\\))?,?\\s*(?:\\n|$)`))
  }
})

test('registry has no legacy, remote, or internal-only static command imports', () => {
  for (const importPath of [
    './commands/autofix-pr/',
    './commands/backfill-sessions/',
    './commands/bughunter/',
    './commands/commit',
    './commands/cost/',
    './commands/good-claude/',
    './commands/issue/',
    './commands/onboarding/',
    './commands/oauth-refresh/',
    './commands/review',
    './commands/session/',
    './commands/share/',
    './commands/summary/',
    './commands/teleport/',
  ]) {
    expect(registry).not.toContain(`from '${importPath}`)
  }

  expect(registry).not.toContain('INTERNAL_ONLY_COMMANDS')
  expect(registry).not.toContain('agentsPlatform')
  expect(registry).not.toContain("process.env.USER_TYPE === 'ant'")
  expect(registry).not.toContain('getWorkflowCommands')
  expect(registry).not.toContain('session, // Shows QR code / URL')
  expect(registry).not.toContain('cost, // Show session cost')
  expect(registry).not.toContain('summary, // Summarize conversation')
})

test('legacy provider-only commands are excluded from the active VEXZY registry', () => {
  for (const name of [
    'fast',
    'remoteSetup',
    'upgrade',
    'desktop',
    'usage',
    'voice',
    'chrome',
    'installGithubApp',
    'installSlackApp',
  ]) {
    expect(activeRegistry).not.toMatch(new RegExp(`\\n\\s*${name}(?:\\(\\))?,?\\s*(?:\\n|$)`))
  }
})

test('bridge and remote-control commands are not registered', () => {
  for (const name of ['remote-control', 'rc', 'remote', 'sync', 'bridge']) {
    expect(activeRegistry).not.toMatch(new RegExp(`\\n\\s*${name}(?:\\(\\))?,?\\s*(?:\\n|$)`))
  }
  expect(registry).not.toContain("./commands/bridge/")
  expect(registry).not.toContain("'../bridge/")
})

test('provider gating is fail-closed and does not depend on legacy auth/provider helpers', () => {
  expect(registry).not.toContain("from './utils/auth.js'")
  expect(registry).not.toContain("from './utils/model/providers.js'")
  expect(registry).toContain('return !cmd.availability || cmd.availability.length === 0')
})
