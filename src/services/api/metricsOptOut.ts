import { logForDebugging } from '../../utils/debug.js'

export type MetricsStatus = {
  enabled: boolean
  hasError: boolean
}

/**
 * Compatibility entry point for the removed remote metrics setting.
 * Metrics export is disabled locally and no settings or credentials are read.
 */
export async function checkMetricsEnabled(): Promise<MetricsStatus> {
  logForDebugging('Remote metrics opt-out lookup is disabled; metrics export is local-only')
  return { enabled: false, hasError: false }
}

/** Retained for callers and tests that clear the former in-memory cache. */
export const _clearMetricsEnabledCacheForTesting = (): void => {}
