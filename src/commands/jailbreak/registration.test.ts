import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('/jailbreak remains registered in the builtin command list', () => {
  const registry = readFileSync(
    new URL('../../commands.ts', import.meta.url),
    'utf8',
  )

  expect(registry).toContain(
    "import jailbreak from './commands/jailbreak/index.js'",
  )
  expect(registry).toMatch(/\n\s*jailbreak,\n/)
})

test('essential custom runtime commands stay registered', () => {
  const registry = readFileSync(
    new URL('../../commands.ts', import.meta.url),
    'utf8',
  )

  for (const command of [
    'agents',
    'compact',
    'effort',
    'jailbreak',
    'mcp',
    'model',
    'skills',
    'status',
    'tasks',
  ]) {
    expect(registry).toMatch(new RegExp(`\\n\\s*${command},\\n`))
  }
})
