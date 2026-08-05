/**
 * Local analytics compatibility API.
 *
 * Production event sinks are intentionally absent. Calls are reduced to a
 * bounded in-memory event counter so local diagnostics can inspect activity
 * without retaining payloads or performing network I/O.
 */

export type AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS = never
export type AnalyticsMetadata_I_VERIFIED_THIS_IS_PII_TAGGED = never

type LogEventMetadata = Record<string, boolean | number | string | undefined>
const localEventCounts = new Map<string, number>()

function normalizeEventName(eventName: string): string {
  const normalized = eventName.trim().slice(0, 128)
  return normalized || 'unknown'
}

export function logEvent(
  eventName: string,
  _metadata: LogEventMetadata,
): void {
  const key = normalizeEventName(eventName)
  localEventCounts.set(key, (localEventCounts.get(key) ?? 0) + 1)
}

export async function logEventAsync(
  eventName: string,
  metadata: LogEventMetadata,
): Promise<void> {
  logEvent(eventName, metadata)
}

export function getLocalEventCounts(): Record<string, number> {
  return Object.fromEntries(localEventCounts)
}

export function _resetForTesting(): void {
  localEventCounts.clear()
}
