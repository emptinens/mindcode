import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'bun:test'

const root = new URL('../../..', import.meta.url).pathname
const handler = readFileSync(`${root}/src/cli/handlers/mcp.tsx`, 'utf8')
const cli = readFileSync(`${root}/src/main.tsx`, 'utf8')
const removedCommand = ['add', 'from', 'claude', 'desktop'].join('-')

describe('MCP legacy desktop import removal', () => {
  test('removes the legacy command and implementation references', () => {
    expect(handler).not.toContain(removedCommand)
    expect(cli).not.toContain(removedCommand)
    const removedDialog = ['MCPServer', 'DesktopImport', 'Dialog'].join('')
    const removedUtil = ['claude', 'Desktop'].join('')
    expect(handler).not.toContain(removedDialog)
    expect(handler).not.toContain(removedUtil)
  })

  test('removes the legacy desktop import modules', () => {
    const removedDialogPath = ['MCPServer', 'DesktopImport', 'Dialog.tsx'].join('')
    const removedUtilPath = ['claude', 'Desktop.ts'].join('')
    expect(existsSync(`${root}/src/components/${removedDialogPath}`)).toBe(false)
    expect(existsSync(`${root}/src/utils/${removedUtilPath}`)).toBe(false)
  })

  test('keeps the standard MCP handlers', () => {
    expect(handler).toContain('export async function mcpAddJsonHandler')
    expect(handler).toContain('export async function mcpListHandler')
    expect(handler).toContain('export async function mcpGetHandler')
    expect(handler).toContain('export async function mcpRemoveHandler')
  })
})
