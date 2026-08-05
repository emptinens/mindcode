import { isClaudeAISubscriber } from 'src/utils/auth.js'
import { getGlobalConfig } from '../../utils/config.js'
import { useStartupNotification } from './useStartupNotification.js'

const MAX_SHOW_COUNT = 3

/**
 * Retained hook surface for startup notification callers. VEXZY has no
 * subscription-account switch flow, so this compatibility path is inert.
 */
export function useCanSwitchToExistingSubscription(): void {
  useStartupNotification(async () => {
    if (isClaudeAISubscriber()) return null
    if ((getGlobalConfig().subscriptionNoticeCount ?? 0) >= MAX_SHOW_COUNT) {
      return null
    }

    // No provider account can be discovered in VEXZY-only mode.
    return null
  })

}
