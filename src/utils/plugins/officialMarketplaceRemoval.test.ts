import { access, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'

const repoRoot = join(import.meta.dir, '..', '..', '..')
const providerHost = ['downloads', 'claude', 'ai'].join('.')

async function sourceFilesUnder(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await sourceFilesUnder(path)))
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(path)
  }
  return files
}

describe('provider marketplace removal', () => {
  test('does not retain provider host or official fetch registration', async () => {
    const sourceFiles = await sourceFilesUnder(join(repoRoot, 'src'))
    const source = await Promise.all(
      sourceFiles.map(async path => ({ path, text: await readFile(path, 'utf8') })),
    )
    const runtimeSource = source
      .filter(({ path }) => !path.endsWith('.test.ts'))
      .map(({ text }) => text)
      .join('\n')

    expect(runtimeSource).not.toContain(providerHost)
    expect(runtimeSource).not.toContain('fetchOfficialMarketplaceFromGcs')
    expect(runtimeSource).not.toContain('officialMarketplaceStartupCheck')
    expect(runtimeSource).not.toContain('tengu_plugin_official_mkt_git_fallback')
  })

  test('does not auto-declare or register the provider marketplace', async () => {
    const marketplaceManager = await readFile(
      join(repoRoot, 'src/utils/plugins/marketplaceManager.ts'),
      'utf8',
    )
    const repl = await readFile(join(repoRoot, 'src/screens/REPL.tsx'), 'utf8')

    expect(marketplaceManager).not.toContain('OFFICIAL_MARKETPLACE_SOURCE')
    expect(marketplaceManager).not.toContain('fetchOfficialMarketplaceFromGcs')
    expect(marketplaceManager).toContain("name.toLowerCase() === 'claude-plugins-official'")
    expect(repl).not.toContain('useOfficialMarketplaceNotification')
  })

  test('deletes startup GCS/retry modules', async () => {
    for (const relativePath of [
      'src/utils/plugins/officialMarketplaceGcs.ts',
      'src/utils/plugins/officialMarketplaceStartupCheck.ts',
      'src/hooks/useOfficialMarketplaceNotification.tsx',
    ]) {
      await expect(access(join(repoRoot, relativePath))).rejects.toThrow()
    }
  })
})
