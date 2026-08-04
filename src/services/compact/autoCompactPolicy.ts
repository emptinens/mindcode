export const DEFAULT_WARNING_PERCENTAGE = 85
export const DEFAULT_AUTO_COMPACT_PERCENTAGE = 95
export const DEFAULT_HARD_LIMIT_PERCENTAGE = 95

export function resolveAutoCompactPercentage(
  override: string | undefined,
  fallback = DEFAULT_AUTO_COMPACT_PERCENTAGE,
): number {
  if (!override) return fallback
  const parsed = Number.parseFloat(override)
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 100
    ? parsed
    : fallback
}

export function calculateWarningThreshold(effectiveContextWindow: number): number {
  return Math.floor(effectiveContextWindow * (DEFAULT_WARNING_PERCENTAGE / 100))
}

export function calculateHardLimitThreshold(effectiveContextWindow: number): number {
  return Math.floor(effectiveContextWindow * (DEFAULT_HARD_LIMIT_PERCENTAGE / 100))
}

export function calculateAutoCompactThreshold(
  effectiveContextWindow: number,
  percentageOverride?: string,
): number {
  const percentage = resolveAutoCompactPercentage(percentageOverride)
  return Math.floor(effectiveContextWindow * (percentage / 100))
}

export function isAutoCompactThresholdReached(
  tokenCount: number,
  threshold: number,
): boolean {
  return tokenCount >= threshold
}
