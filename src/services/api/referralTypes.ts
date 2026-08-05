export type ReferralCampaign = string

export type BillingType = string

export type ReferrerRewardInfo = {
  amount_minor_units: number
  currency: string
}

export type ReferralCodeDetails = {
  referral_link?: string
  campaign?: ReferralCampaign
}

export type ReferralEligibilityResponse = {
  eligible: boolean
  referral_code_details?: ReferralCodeDetails
  referrer_reward?: ReferrerRewardInfo | null
  remaining_passes?: number
  [key: string]: unknown
}

export type ReferralRedemption = Record<string, unknown>

export type ReferralRedemptionsResponse = {
  redemptions?: ReferralRedemption[]
  limit?: number
  [key: string]: unknown
}
