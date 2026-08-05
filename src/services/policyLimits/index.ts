/**
 * Local policy-limits compatibility boundary.
 *
 * MindCode has no remote organization-policy endpoint.  Policy checks are
 * therefore deterministic and default-allow, while the historical lifecycle
 * exports remain available to startup and UI callers.
 */

let loadingCompletePromise: Promise<void> | null = null

/** Test-only reset for the local compatibility state. */
export function _resetPolicyLimitsForTesting(): void {
  loadingCompletePromise = null
}

/** No remote policy source exists in VEXZY mode. */
export function initializePolicyLimitsLoadingPromise(): void {
  loadingCompletePromise = Promise.resolve()
}

/** Policy loading is always complete because it is local-only. */
export async function waitForPolicyLimitsToLoad(): Promise<void> {
  await loadingCompletePromise
}

/** No organization policy endpoint is configured for MindCode. */
export function isPolicyLimitsEligible(): boolean {
  return false
}

/** Unknown or legacy policy names are allowed by the local default policy. */
export function isPolicyAllowed(_policy: string): boolean {
  return true
}

/** Deterministic local no-op retained for initialization callers. */
export async function loadPolicyLimits(): Promise<void> {
  loadingCompletePromise = Promise.resolve()
}

/** Deterministic local no-op retained for auth-change callers. */
export async function refreshPolicyLimits(): Promise<void> {
  loadingCompletePromise = Promise.resolve()
}

/** Clear only local compatibility state; no disk or network I/O occurs. */
export async function clearPolicyLimitsCache(): Promise<void> {
  loadingCompletePromise = null
}

/** Background polling is intentionally disabled. */
export function startBackgroundPolling(): void {
}

/** Background polling is intentionally disabled. */
export function stopBackgroundPolling(): void {
}
