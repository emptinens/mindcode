/** Local compatibility API for the removed referral and guest-pass endpoints. */

import type {
  ReferralCampaign,
  ReferralEligibilityResponse,
  ReferralRedemptionsResponse,
  ReferrerRewardInfo,
} from './referralTypes.js'

const NO_REFERRAL_ELIGIBILITY: ReferralEligibilityResponse = Object.freeze({
  eligible: false,
})

/** Deterministic unavailable result; performs no I/O. */
export async function fetchReferralEligibility(
  _campaign: ReferralCampaign = 'mindcode_guest_pass',
): Promise<ReferralEligibilityResponse> {
  return NO_REFERRAL_ELIGIBILITY
}

/** Deterministic empty result; performs no I/O. */
export async function fetchReferralRedemptions(
  _campaign = 'mindcode_guest_pass',
): Promise<ReferralRedemptionsResponse> {
  return { redemptions: [], limit: 0 }
}

export function checkCachedPassesEligibility(): {
  eligible: boolean
  needsRefresh: boolean
  hasCache: boolean
} {
  return { eligible: false, needsRefresh: false, hasCache: false }
}

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  BRL: 'R$',
  CAD: 'CA$',
  AUD: 'A$',
  NZD: 'NZ$',
  SGD: 'S$',
}

export function formatCreditAmount(reward: ReferrerRewardInfo): string {
  const symbol = CURRENCY_SYMBOLS[reward.currency] ?? `${reward.currency} `
  const amount = reward.amount_minor_units / 100
  const formatted = amount % 1 === 0 ? amount.toString() : amount.toFixed(2)
  return `${symbol}${formatted}`
}

export function getCachedReferrerReward(): ReferrerRewardInfo | null {
  return null
}

export function getCachedRemainingPasses(): number | null {
  return null
}

export async function fetchAndStorePassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  return null
}

export async function getCachedOrFetchPassesEligibility(): Promise<ReferralEligibilityResponse | null> {
  return null
}

export async function prefetchPassesEligibility(): Promise<void> {
  return undefined
}
