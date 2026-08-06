import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getVexzyModelCatalogState } from '../../services/api/vexzy/modelCatalog.js'
import type { ModelAlias } from './aliases.js'
import {
  FIXED_SUBAGENT_MODEL,
  FIXED_SUBAGENT_MODEL_DISPLAY,
  getConfiguredSubagentModel,
} from './subagentModel.js'

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
  return getConfiguredSubagentModel()
}

export class FixedSubagentModelUnavailableError extends Error {
  readonly code = 'FIXED_SUBAGENT_MODEL_UNAVAILABLE'

  constructor(reason: string) {
    super(`Fixed Worker model is unavailable: ${reason}`)
    this.name = 'FixedSubagentModelUnavailableError'
  }
}

/**
 * Resolve the only permitted worker model from the ready VEXZY catalog.
 *
 * A static model string is not sufficient: workers require a live catalog
 * entry that is available and exposes tool execution. This resolver fails
 * closed when the catalog is loading, stale, missing, or incompatible.
 */
export function resolveFixedSubagentModel(): string {
  const configuredModel = FIXED_SUBAGENT_MODEL
  const catalog = getVexzyModelCatalogState()
  if (catalog.state !== 'ready' || catalog.registry === undefined) {
    throw new FixedSubagentModelUnavailableError(
      `VEXZY model catalog is not ready (state: ${catalog.state})`,
    )
  }

  const model = catalog.registry.get(configuredModel)
  if (model === undefined) {
    throw new FixedSubagentModelUnavailableError('model is absent from catalog')
  }
  if (model.available !== true) {
    throw new FixedSubagentModelUnavailableError('model is not available')
  }
  if (model.tools !== true || model.capabilities.tools !== true) {
    throw new FixedSubagentModelUnavailableError(
      'model does not support tool execution',
    )
  }

  return configuredModel
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
  return resolveFixedSubagentModel()
}

export function getAgentModelDisplay(_model: string | undefined): string {
  return FIXED_SUBAGENT_MODEL_DISPLAY
}

/**
 * Get available model options for agents
 */
export function getAgentModelOptions(): AgentModelOption[] {
  let model: string
  try {
    model = resolveFixedSubagentModel()
  } catch {
    return []
  }
  return [
    {
      value: model,
      label: getAgentModelDisplay(model),
      description: 'Fixed exact VEXZY model for every Worker/subagent',
    },
  ]
}
