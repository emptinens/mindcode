/**
 * Analytics service - public API for event logging (all backends removed)
 */

export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

type LogEventMetadata = { [key: string]: boolean | number | undefined }

export function logEvent(
  _eventName: string,
  _metadata: LogEventMetadata,
): void {
  return
}

export async function logEventAsync(
  _eventName: string,
  _metadata: LogEventMetadata,
): Promise<void> {
  return
}

export function _resetForTesting(): void {}
