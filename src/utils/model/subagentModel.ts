import { getInitialSettings, updateSettingsForSource } from '../settings/settings.js'

/** Default Worker model. Configured values are exact VEXZY model IDs. */
export const FIXED_SUBAGENT_MODEL = 'gpt-5.6-luna'

/** Stable UI label for the pinned worker model. */
export const FIXED_SUBAGENT_MODEL_DISPLAY = 'GPT-5.6 Luna'

export function getConfiguredSubagentModel(): string {
  return getInitialSettings().subagentModel?.trim() || FIXED_SUBAGENT_MODEL
}

export function persistSubagentModel(model: string): { error: Error | null } {
  return updateSettingsForSource('userSettings', { subagentModel: model })
}
