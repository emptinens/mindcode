// The official registry is intentionally unavailable in VEXZY builds. Keep a
// local, empty set so callers retain the API while the lookup stays fail-closed.
const officialUrls = new Set<string>()

/**
 * Compatibility no-op for the removed official MCP registry prefetch.
 */
export async function prefetchOfficialMcpUrls(): Promise<void> {
  officialUrls.clear()
}

/**
 * Returns true iff the given (already-normalized via getLoggingSafeMcpBaseUrl)
 * URL is in the official MCP registry. Undefined registry → false (fail-closed).
 */
export function isOfficialMcpUrl(normalizedUrl: string): boolean {
  return officialUrls?.has(normalizedUrl) ?? false
}

export function resetOfficialMcpUrlsForTesting(): void {
  officialUrls.clear()
}
