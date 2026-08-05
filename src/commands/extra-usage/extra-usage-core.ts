import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'

type ExtraUsageResult =
  | { type: 'message'; value: string }
  | { type: 'browser-opened'; url: string; opened: boolean }
  | { type: 'admin-request-confirmation'; extraUsageAlreadyEnabled: boolean }

/**
 * Organization-admin requests are not part of the VEXZY API boundary.
 * Preserve the command result shape without contacting a remote service.
 */
export async function submitExtraUsageAdminRequest(
  _extraUsageAlreadyEnabled: boolean,
): Promise<ExtraUsageResult> {
  return {
    type: 'message',
    value: 'Organization usage-credit requests are unavailable in VEXZY mode.',
  }
}

/** Mark the local visit and report that account usage is not a VEXZY resource. */
export async function runExtraUsage(): Promise<ExtraUsageResult> {
  if (!getGlobalConfig().hasVisitedExtraUsage) {
    saveGlobalConfig(prev => ({ ...prev, hasVisitedExtraUsage: true }))
  }

  return {
    type: 'message',
    value: 'Subscription usage management is unavailable in VEXZY mode.',
  }
}
