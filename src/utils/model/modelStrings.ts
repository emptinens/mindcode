import {
  getDefaultVexzyModelCatalog,
  getVexzyModelCatalogState,
  loadVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'

/**
 * Dynamic compatibility view of the VEXZY catalog.
 *
 * The old implementation exposed one hardcoded field per Claude model and
 * translated those fields for Bedrock, Vertex, and Foundry. That shape cannot
 * represent future VEXZY IDs faithfully, so keys and values are now the exact
 * IDs supplied by `/models`.
 */
export type ModelStrings = Readonly<Record<string, string>>

export function getModelStrings(): ModelStrings {
  const registry = getVexzyModelCatalogState().registry
  if (registry === undefined) return {}

  return Object.fromEntries(
    registry.models
      .filter(model => model.available)
      .map(model => [model.id, model.id]),
  )
}

/** Provider translation was removed; VEXZY IDs are already wire IDs. */
export function resolveOverriddenModel(modelId: string): string {
  return modelId
}

export async function ensureModelStringsInitialized(): Promise<void> {
  const state = getDefaultVexzyModelCatalog().getState()
  if (state.state !== 'ready') {
    await loadVexzyModelCatalog()
  }
}
