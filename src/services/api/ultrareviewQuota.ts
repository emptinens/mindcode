/** Local compatibility API for the removed ultrareview quota endpoint. */

export type UltrareviewQuotaResponse = {
  reviews_used: number
  reviews_limit: number
  reviews_remaining: number
  is_overage: boolean
}

/** VEXZY does not expose a separate ultrareview quota resource. */
export async function fetchUltrareviewQuota(): Promise<UltrareviewQuotaResponse | null> {
  return null
}
