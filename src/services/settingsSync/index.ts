/**
 * Local settings-sync compatibility boundary.
 *
 * MindCode settings are local state.  The historical remote sync service is
 * intentionally unavailable in VEXZY mode, but these exports remain so
 * startup and plugin code can keep a stable, non-blocking call shape.
 */

import type {
  SettingsSyncFetchResult,
  SettingsSyncUploadResult,
} from './types.js'

let downloadPromise: Promise<boolean> | null = null

/** Local-only no-op retained for startup compatibility. */
export async function uploadUserSettingsInBackground(): Promise<void> {
  return undefined
}

/** Test-only reset for the deterministic local promise cache. */
export function _resetDownloadPromiseForTesting(): void {
  downloadPromise = null
}

/**
 * Remote settings are not fetched in MindCode.  Keep a stable cached promise
 * so duplicate startup callers observe the same deterministic result.
 */
export function downloadUserSettings(): Promise<boolean> {
  if (downloadPromise === null) {
    downloadPromise = Promise.resolve(false)
  }
  return downloadPromise
}

/** Force the same local no-op result as a fresh compatibility call. */
export function redownloadUserSettings(): Promise<boolean> {
  downloadPromise = Promise.resolve(false)
  return downloadPromise
}

// Keep the result types reachable from the compatibility module for consumers
// that used the old service as their import boundary.
export type { SettingsSyncFetchResult, SettingsSyncUploadResult }
