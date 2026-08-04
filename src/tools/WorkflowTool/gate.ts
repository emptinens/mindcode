// Runtime enablement for dynamic workflows. The tool is only compiled in when
// the WORKFLOW_SCRIPTS build flag is on; this is the runtime off-switch
// (managed-settings `disableWorkflows` / CLAUDE_CODE_DISABLE_WORKFLOWS) and the
// per-session ultracode keyword-trigger toggle.

import { isEnvTruthy } from '../../utils/envUtils.js'

export function areWorkflowsDisabledByManagedSettings(): boolean {
  return isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOWS)
}

export function isWorkflowsEnabled(): boolean {
  return !areWorkflowsDisabledByManagedSettings()
}

export function isWorkflowKeywordTriggerEnabled(): boolean {
  // Default on; opt out with CLAUDE_CODE_DISABLE_WORKFLOW_KEYWORD=1.
  return !isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_WORKFLOW_KEYWORD)
}

// Session-scoped "ultracode" mode: xhigh effort + standing dynamic-workflow
// orchestration. Set via `/effort ultracode`; never persisted (interactive
// toggles are session-only, matching the upstream behavior).
let ultracodeSessionEnabled = isEnvTruthy(process.env.CLAUDE_CODE_ULTRACODE)

export function isUltracodeSessionEnabled(): boolean {
  return ultracodeSessionEnabled && isWorkflowsEnabled()
}

export function setUltracodeSessionEnabled(on: boolean): void {
  ultracodeSessionEnabled = on
}
