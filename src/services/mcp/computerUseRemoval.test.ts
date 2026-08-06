import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = new URL('../../', import.meta.url)
const internalPackage = ['@ant', 'computer-use'].join('/')
const internalFeature = ['CHICAGO', 'MCP'].join('_')
const internalState = ['computer', 'Use', 'Mcp', 'State'].join('')
const internalCliFlag = ['--computer', '-use-mcp'].join('')
const internalPath = ['utils', 'computerUse'].join('/')

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry)
    return statSync(path).isDirectory() ? collectSourceFiles(path) : [path]
  })
}

describe('computer-use removal', () => {
  test('removes the unavailable package and approval UI', () => {
    const files = collectSourceFiles(sourceRoot.pathname).filter(
      path => !path.includes('.test.'),
    )
    const source = files.map(path => readFileSync(path, 'utf8')).join('\n')

    expect(existsSync(join(sourceRoot.pathname, 'utils/computerUse'))).toBe(
      false,
    )
    expect(
      existsSync(
        join(
          sourceRoot.pathname,
          'components/permissions/ComputerUseApproval',
        ),
      ),
    ).toBe(false)
    expect(source).not.toContain(internalPackage)
    expect(source).not.toContain(internalFeature)
    expect(source).not.toContain(internalState)
    expect(source).not.toContain(internalCliFlag)
    expect(source).not.toContain(internalPath)
  })

  test('keeps generic MCP transport and tool discovery', () => {
    const client = readFileSync(
      new URL('./client.ts', import.meta.url),
      'utf8',
    )
    const adaptiveTransport = readFileSync(
      new URL('./AdaptiveStdioTransport.ts', import.meta.url),
      'utf8',
    )
    expect(client).toContain('new AdaptiveStdioTransport')
    expect(adaptiveTransport).toContain('new StdioClientTransport')
    expect(client).toContain('fetchToolsForClient')
    expect(client).not.toContain(internalPackage)
    expect(client).not.toContain(internalFeature)
  })
})
