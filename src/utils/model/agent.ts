import type { PermissionMode } from '../permissions/PermissionMode.js'
import type { ModelAlias } from './aliases.js'
import {
  FIXED_SUBAGENT_MODEL,
  FIXED_SUBAGENT_MODEL_DISPLAY,
} from './subagentModel.js'

export const AGENT_MODEL_OPTIONS = [FIXED_SUBAGENT_MODEL] as const
export type AgentModelAlias = ModelAlias | 'inherit'

export type AgentModelOption = {
  value: string
  label: string
  description: string
}

/**
 * Get the model shown for newly created subagents.
 */
export function getDefaultSubagentModel(): string {
  return FIXED_SUBAGENT_MODEL
}

/**
 * Get the effective model string for a non-swarm subagent.
 *
 * This is the single model-resolution boundary used by AgentTool and resumed
 * AgentTool tasks. Keep the leader model user-selectable, but never allow an
 * agent definition, tool argument, environment override, or resume path to
 * change the worker model.
 */
export function getAgentModel(
  _agentModel: string | undefined,
  _parentModel: string,
  _toolSpecifiedModel?: ModelAlias,
  _permissionMode?: PermissionMode,
): string {
  // Keep every Agent subagent on the dedicated Luna model. The leader's
  // model and tool-level model aliases only control the main session.
  return FIXED_SUBAGENT_MODEL
}

export function getAgentModelDisplay(_model: string | undefined): string {
  return FIXED_SUBAGENT_MODEL_DISPLAY
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  return [
    {
      value: FIXED_SUBAGENT_MODEL,
      label: FIXED_SUBAGENT_MODEL_DISPLAY,
      description: 'Fixed model for every agent and teammate',
    },
  ]
}
