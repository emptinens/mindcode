import {
  getVexzyModelCatalogState,
  loadVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'

/** Compatibility projection backed exclusively by the ready VEXZY catalog. */
export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

export function getModelCapability(model: string): ModelCapability | undefined {
  const entry = getVexzyModelCatalogState().registry?.get(model)
  if (!entry) return undefined
  return {
    id: entry.id,
    max_input_tokens: entry.contextLength,
    max_tokens: entry.outputLimit,
  }
}

export async function refreshModelCapabilities(): Promise<void> {
  await loadVexzyModelCatalog({ refresh: true })
}
