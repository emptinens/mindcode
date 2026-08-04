import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import type { Command } from '../../commands.js'
import { isOverageProvisioningAllowed } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

function isExtraUsageAllowed(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }
  return isOverageProvisioningAllowed()
}

export const extraUsage = {
  type: 'local-jsx',
  name: 'extra-usage',
  description: 'Legacy alias for /usage-credits',
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  isHidden: true,
  load: () => import('./extra-usage.js'),
} satisfies Command

export const extraUsageNonInteractive = {
  type: 'local',
  name: 'extra-usage',
  supportsNonInteractive: true,
  description: 'Legacy alias for /usage-credits',
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  isHidden: true,
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command

export const usageCredits = {
  type: 'local-jsx',
  name: 'usage-credits',
  description: 'Configure usage credits to keep working when limits are hit',
  isEnabled: () => isExtraUsageAllowed() && !getIsNonInteractiveSession(),
  load: () => import('./extra-usage.js'),
} satisfies Command

export const usageCreditsNonInteractive = {
  type: 'local',
  name: 'usage-credits',
  supportsNonInteractive: true,
  description: 'Configure usage credits to keep working when limits are hit',
  isEnabled: () => isExtraUsageAllowed() && getIsNonInteractiveSession(),
  get isHidden() {
    return !getIsNonInteractiveSession()
  },
  load: () => import('./extra-usage-noninteractive.js'),
} satisfies Command
