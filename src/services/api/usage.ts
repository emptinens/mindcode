/**
 * Local usage compatibility API.
 *
 * VEXZY exposes model calls and model metadata only.  Subscription usage is
 * not queried from an undocumented account endpoint, so callers receive the
 * same empty result used for an unavailable subscription account.
 */

export type RateLimit = {
  utilization: number | null
  resets_at: string | null
}

export type ExtraUsage = {
  is_enabled: boolean
  monthly_limit: number | null
  used_credits: number | null
  utilization: number | null
}

export type Utilization = {
  five_hour?: RateLimit | null
  seven_day?: RateLimit | null
  seven_day_oauth_apps?: RateLimit | null
  seven_day_opus?: RateLimit | null
  seven_day_sonnet?: RateLimit | null
  extra_usage?: ExtraUsage | null
}

/** Deterministic local result; performs no I/O. */
export async function fetchUtilization(): Promise<Utilization | null> {
  return {}
}
