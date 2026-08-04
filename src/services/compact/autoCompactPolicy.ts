export const DEFAULT_AUTO_COMPACT_PERCENTAGE = 85

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
