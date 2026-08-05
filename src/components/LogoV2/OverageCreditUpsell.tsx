import type * as React from 'react'
import type { FeedConfig } from './Feed.js'

/** Compatibility exports; provider overage promotions are disabled in MindCode. */
export function isEligibleForOverageCreditGrant(): boolean {
  return false
}

export function shouldShowOverageCreditUpsell(): boolean {
  return false
}

export function maybeRefreshOverageCreditCache(): void {}

export function useShowOverageCreditUpsell(): boolean {
  return false
}

export function incrementOverageCreditUpsellSeenCount(): void {}

export function OverageCreditUpsell(): React.ReactNode {
  return null
}

export function createOverageCreditFeed(): FeedConfig {
  return { title: 'Usage', lines: [], emptyMessage: 'No provider promotions' }
}
