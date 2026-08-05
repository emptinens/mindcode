import type * as React from 'react'

/** Compatibility exports; subscription-pass promotions are disabled in MindCode. */
export function useShowGuestPassesUpsell(): boolean {
  return false
}

export function incrementGuestPassesSeenCount(): void {}

export function GuestPassesUpsell(): React.ReactNode {
  return null
}
