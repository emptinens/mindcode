import { expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const repositoryRoot = resolve(import.meta.dir, '../../..')
const readSource = (relativePath: string): string =>
  readFileSync(resolve(repositoryRoot, relativePath), 'utf8')

test('PromptInput no longer exposes the removed fast picker surface', () => {
  const promptInput = readSource('src/components/PromptInput/PromptInput.tsx')
  const helpMenu = readSource(
    'src/components/PromptInput/PromptInputHelpMenu.tsx',
  )
  const defaultBindings = readSource('src/keybindings/defaultBindings.ts')
  const schema = readSource('src/keybindings/schema.ts')

  for (const source of [promptInput, helpMenu, defaultBindings, schema]) {
    expect(source).not.toContain('chat:fastMode')
    expect(source).not.toContain('FastModePicker')
    expect(source).not.toContain('fastModePicker')
  }
})

test('removed fast and thinkback command modules have no source files', () => {
  for (const relativePath of [
    'src/commands/fast/fast.tsx',
    'src/commands/thinkback/thinkback.tsx',
    'src/commands/thinkback-play/index.ts',
    'src/commands/thinkback-play/thinkback-play.ts',
  ]) {
    expect(existsSync(resolve(repositoryRoot, relativePath))).toBe(false)
  }
})
