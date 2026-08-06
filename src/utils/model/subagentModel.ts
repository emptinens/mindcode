/** Fixed Worker model for every Agent/teammate runtime. */
export const FIXED_SUBAGENT_MODEL = 'gpt-5.6-luna'

/** Stable UI label for the pinned worker model. */
export const FIXED_SUBAGENT_MODEL_DISPLAY = 'GPT-5.6 Luna'

export function getConfiguredSubagentModel(): string {
  return FIXED_SUBAGENT_MODEL
}

/**
 * Compatibility setter for persisted/UI configuration.
 *
 * Worker model selection is intentionally not mutable: the runtime boundary
 * always uses GPT-5.6 Luna. Keeping this function preserves callers that load
 * older settings without allowing them to change Worker routing.
 */
export function setConfiguredSubagentModel(_model: string | undefined): string {
  return FIXED_SUBAGENT_MODEL
}
