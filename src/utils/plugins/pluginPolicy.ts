export {
  evaluateMindCodeMcpPolicy,
  evaluateMindCodePluginPolicy,
  getMindCodePluginPolicyDiagnostic,
  MINDCODE_ALLOWED_PLUGIN_ALIASES,
  normalizeMindCodePolicyName,
  resolveMindCodeAllowedAlias,
} from './mindcodePluginPolicy.js'

/**
 * Plugin policy checks backed by managed settings (policySettings).
 *
 * Kept as a leaf module (only imports settings) to avoid circular dependencies
 * — marketplaceHelpers.ts imports marketplaceManager.ts which transitively
 * reaches most of the plugin subsystem.
 */

import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Check if a plugin is force-disabled by org policy (managed-settings.json).
 * Policy-blocked plugins cannot be installed or enabled by the user at any
 * scope. Used as the single source of truth for policy blocking across the
 * install chokepoint, enable op, and UI filters.
 */
export function isPluginBlockedByPolicy(pluginId: string): boolean {
  const { getSettingsForSource } = require('../settings/settings.js') as typeof import('../settings/settings.js')
  const policyEnabled = getSettingsForSource('policySettings')?.enabledPlugins
  return policyEnabled?.[pluginId] === false
}
