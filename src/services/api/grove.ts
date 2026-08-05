/**
 * Local compatibility API for the removed account/Grove endpoints.
 *
 * The UI imports these shapes, but the account feature is not backed by a
 * VEXZY resource.  Returning a failed result keeps the existing callers
 * non-blocking and prevents any network access.
 */

export type AccountSettings = {
  grove_enabled: boolean | null
  grove_notice_viewed_at: string | null
}

export type GroveConfig = {
  grove_enabled: boolean
  domain_excluded: boolean
  notice_is_grace_period: boolean
  notice_reminder_frequency: number | null
}

export type ApiResult<T> = { success: true; data: T } | { success: false }

export async function getGroveSettings(): Promise<ApiResult<AccountSettings>> {
  return { success: false }
}

export async function markGroveNoticeViewed(): Promise<void> {
  return undefined
}

export async function updateGroveSettings(
  _groveEnabled: boolean,
): Promise<void> {
  return undefined
}

export async function isQualifiedForGrove(): Promise<boolean> {
  return false
}

export async function getGroveNoticeConfig(): Promise<ApiResult<GroveConfig>> {
  return { success: false }
}

export function calculateShouldShowGrove(
  _settingsResult: ApiResult<AccountSettings>,
  _configResult: ApiResult<GroveConfig>,
  _showIfAlreadyViewed: boolean,
): boolean {
  return false
}

export async function checkGroveForNonInteractive(): Promise<void> {
  return undefined
}
