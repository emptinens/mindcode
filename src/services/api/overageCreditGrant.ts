/** Local compatibility API for the removed organization credit-grant endpoint. */

export type OverageCreditGrantInfo = {
  available: boolean
  eligible: boolean
  granted: boolean
  amount_minor_units: number | null
  currency: string | null
}

/** No remote grant cache exists in VEXZY mode. */
export function getCachedOverageCreditGrant(): OverageCreditGrantInfo | null {
  return null
}

/** Cache invalidation is a local no-op because no cache is maintained. */
export function invalidateOverageCreditGrantCache(): void {
}

/** Refresh is a deterministic no-op and performs no I/O. */
export async function refreshOverageCreditGrantCache(): Promise<void> {
  return undefined
}

export function formatGrantAmount(info: OverageCreditGrantInfo): string | null {
  if (info.amount_minor_units == null || !info.currency) return null
  if (info.currency.toUpperCase() === 'USD') {
    const dollars = info.amount_minor_units / 100
    return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`
  }
  return null
}

export type OverageCreditGrantCacheEntry = {
  info: OverageCreditGrantInfo
  timestamp: number
}
