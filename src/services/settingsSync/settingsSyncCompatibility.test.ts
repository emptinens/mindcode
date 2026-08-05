import { describe, expect, test } from 'bun:test'
import {
  _resetDownloadPromiseForTesting,
  downloadUserSettings,
  redownloadUserSettings,
  uploadUserSettingsInBackground,
} from './index.js'

describe('local settings-sync compatibility boundary', () => {
  test('keeps all sync operations deterministic and local', async () => {
    _resetDownloadPromiseForTesting()

    await expect(uploadUserSettingsInBackground()).resolves.toBeUndefined()
    await expect(downloadUserSettings()).resolves.toBe(false)
    await expect(downloadUserSettings()).resolves.toBe(false)
    await expect(redownloadUserSettings()).resolves.toBe(false)
  })

  test('does not expose a remote endpoint or HTTP client', async () => {
    const source = await Bun.file(
      new URL('./index.ts', import.meta.url),
    ).text()

    expect(source).not.toContain('axios')
    expect(source).not.toContain('getOauthConfig')
    expect(source).not.toContain('/api/')
    expect(source).not.toContain('fetch(')
  })
})
