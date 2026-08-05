/** Default Worker model. Configured values are exact VEXZY model IDs. */
export const FIXED_SUBAGENT_MODEL = 'gpt-5.6-luna'

/** Stable UI label for the pinned worker model. */
export const FIXED_SUBAGENT_MODEL_DISPLAY = 'GPT-5.6 Luna'

let configuredSubagentModel = FIXED_SUBAGENT_MODEL

export function getConfiguredSubagentModel(): string {
  return configuredSubagentModel
}

export function setConfiguredSubagentModel(model: string | undefined): string {
  configuredSubagentModel = model?.trim() || FIXED_SUBAGENT_MODEL
  return configuredSubagentModel
}
