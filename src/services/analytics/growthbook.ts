/**
 * GrowthBook stub — all feature flags return their default values.
 * No network calls are made.
 */

export type GrowthBookUserAttributes = Record<string, unknown>

export function onGrowthBookRefresh(_cb: () => void): () => void {
  return () => {}
}

export function hasGrowthBookEnvOverride(_key: string): boolean {
  return false
}

export function getAllGrowthBookFeatures(): Record<string, unknown> {
  return {}
}

export function getGrowthBookConfigOverrides(): Record<string, unknown> {
  return {}
}

export function setGrowthBookConfigOverride(_key: string, _value: unknown): void {}

export function clearGrowthBookConfigOverrides(): void {}

export function getApiBaseUrlHost(): string | undefined {
  return undefined
}

export const initializeGrowthBook = async (): Promise<void> => {}

export function getFeatureValue_DEPRECATED<T>(_key: string, defaultValue: T): T {
  return defaultValue
}

export function getFeatureValue_CACHED_MAY_BE_STALE<T>(_key: string, defaultValue: T): T {
  return defaultValue
}

export function getFeatureValue_CACHED_WITH_REFRESH<T>(_key: string, defaultValue: T, _refreshMs?: number): T {
  return defaultValue
}

export function checkStatsigFeatureGate_CACHED_MAY_BE_STALE(_key: string): boolean {
  return false
}

export function checkSecurityRestrictionGate(_key: string): boolean {
  return false
}

export async function checkGate_CACHED_OR_BLOCKING(_key: string): Promise<boolean> {
  return false
}

export async function refreshGrowthBookAfterAuthChange(): Promise<void> {}

export function resetGrowthBook(): void {}

export async function refreshGrowthBookFeatures(): Promise<void> {}

export function setupPeriodicGrowthBookRefresh(): void {}

export function stopPeriodicGrowthBookRefresh(): void {}

export async function getDynamicConfig_BLOCKS_ON_INIT<T>(_key: string, defaultValue: T): Promise<T> {
  return defaultValue
}

export function getDynamicConfig_CACHED_MAY_BE_STALE<T>(_key: string, defaultValue: T): T {
  return defaultValue
}
