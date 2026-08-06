import type { PermissionMode } from '../permissions/PermissionMode.js'
import type { ModelAlias } from './aliases.js'
import {
  FixedSubagentModelUnavailableError,
  workerModelResolver,
} from './resolvers.js'
import { FIXED_SUBAGENT_MODEL_DISPLAY } from './subagentModel.js'

export { FixedSubagentModelUnavailableError } from './resolvers.js'

export type AgentModelAlias = ModelAlias | 'inherit'

export type AgentModelOption = {
  value: string
  label: string
  description: string
}

/** Get the model shown for newly created subagents. */
export function getDefaultSubagentModel(): string {
  return workerModelResolver.fixedModel
}

/** Resolve the only permitted worker model from the public Worker boundary. */
export function resolveFixedSubagentModel(): string {
  return workerModelResolver.resolve()
}

/**
 * Get the effective model string for a non-swarm subagent.
 *
 * The leader's model and tool-level model aliases only control the main
 * session. Every Worker resolves through WorkerModelResolver.
 */
export function getAgentModel(
  _agentModel: string | undefined,
  _parentModel: string,
  _toolSpecifiedModel?: ModelAlias,
  _permissionMode?: PermissionMode,
): string {
  return workerModelResolver.resolve()
}

export function getAgentModelDisplay(_model: string | undefined): string {
  return FIXED_SUBAGENT_MODEL_DISPLAY
}

/** Get available model options for agents. */
export function getAgentModelOptions(): AgentModelOption[] {
  let model: string
  try {
    model = workerModelResolver.resolve()
  } catch (error) {
    if (error instanceof FixedSubagentModelUnavailableError) return []
    throw error
  }
  return [
    {
      value: model,
      label: getAgentModelDisplay(model),
      description: 'Fixed exact VEXZY model for every Worker/subagent',
    },
  ]
}
