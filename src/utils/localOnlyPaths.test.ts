import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')

const localOnlyFiles = {
  env: read('src/utils/env.ts'),
  setup: read('src/setup.ts'),
  releaseNotes: read('src/utils/releaseNotes.ts'),
  installCounts: read('src/utils/plugins/installCounts.ts'),
  insights: read('src/commands/insights.ts'),
  nativeDownload: read('src/utils/nativeInstaller/download.ts'),
  ide: read('src/utils/ide.ts'),
}

describe('MindCode local-only runtime paths', () => {
  test('startup has no internet probe', () => {
    expect(localOnlyFiles.env).not.toContain("from 'axios'")
    expect(localOnlyFiles.env).not.toContain('1.1.1.1')
    expect(localOnlyFiles.env).not.toContain('hasInternetAccess')
    expect(localOnlyFiles.setup).not.toContain('hasInternetAccess')
    expect(localOnlyFiles.setup).not.toContain('env.hasInternetAccess')
  })

  test('release notes read local sources without remote refreshes', () => {
    expect(localOnlyFiles.releaseNotes).not.toContain("from 'axios'")
    expect(localOnlyFiles.releaseNotes).not.toContain('raw.githubusercontent.com')
    expect(localOnlyFiles.releaseNotes).not.toContain('github.com')
    expect(localOnlyFiles.releaseNotes).toContain('getChangelogCachePath')
    expect(localOnlyFiles.releaseNotes).toContain('VERSION_CHANGELOG')
  })

  test('plugin counts are local cache plus zero fallback', () => {
    expect(localOnlyFiles.installCounts).not.toContain("from 'axios'")
    expect(localOnlyFiles.installCounts).not.toContain('raw.githubusercontent.com')
    expect(localOnlyFiles.installCounts).not.toContain('fetchInstallCountsFromGitHub')
    expect(localOnlyFiles.installCounts).toContain('return new Map()')
  })

  test('insights stay as a local HTML report', () => {
    expect(localOnlyFiles.insights).not.toContain('fonts.googleapis.com')
    expect(localOnlyFiles.insights).not.toContain('s3://')
    expect(localOnlyFiles.insights).not.toContain('s3-frontend.infra.ant.dev')
    expect(localOnlyFiles.insights).not.toContain('execFileSync')
    expect(localOnlyFiles.insights).toContain('file://${htmlPath}')
  })

  test('native update and IDE extension downloads fail locally', () => {
    expect(localOnlyFiles.nativeDownload).not.toContain("from 'axios'")
    expect(localOnlyFiles.nativeDownload).not.toContain('storage.googleapis.com')
    expect(localOnlyFiles.nativeDownload).not.toContain('artifactory')
    expect(localOnlyFiles.nativeDownload).not.toContain('MINDCODE_RELEASE_BASE_URL')
    expect(localOnlyFiles.nativeDownload).toContain('LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE')

    expect(localOnlyFiles.ide).not.toContain("from 'axios'")
    expect(localOnlyFiles.ide).not.toContain('artifactory')
    expect(localOnlyFiles.ide).not.toContain('--install-extension')
    expect(localOnlyFiles.ide).not.toContain('.vsix')
  })
})

describe('local native update boundary', () => {
  test('keeps direct version parsing but rejects provider channels and downloads', async () => {
    const {
      LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE,
      downloadVersion,
      getLatestVersion,
    } = await import('./nativeInstaller/download.js')

    expect(await getLatestVersion('v0.1.0')).toBe('0.1.0')
    await expect(getLatestVersion('latest')).rejects.toThrow(
      LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE,
    )
    await expect(downloadVersion('0.1.0', '/tmp/mindcode-staging')).rejects.toThrow(
      LOCAL_NATIVE_UPDATE_DISABLED_MESSAGE,
    )
  })
})
