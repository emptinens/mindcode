import {
  getDefaultVexzyModelCatalog,
  loadVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import {
  FIXED_SUBAGENT_MODEL,
} from '../../utils/model/subagentModel.js'

export async function ensureSubmodelCatalogReady(): Promise<void> {
  if (getDefaultVexzyModelCatalog().state === 'ready') return
  await loadVexzyModelCatalog()
}

export async function setSubmodel(model: string): Promise<string> {
  if (model !== FIXED_SUBAGENT_MODEL) {
    throw new Error(
      `Worker/subagent model is fixed to ${FIXED_SUBAGENT_MODEL}`,
    )
  }

  const entry = getDefaultVexzyModelCatalog().registry?.get(
    FIXED_SUBAGENT_MODEL,
  )
  if (!entry || !entry.available || !entry.tools || !entry.capabilities.tools) {
    throw new Error(
      `Fixed Worker model '${FIXED_SUBAGENT_MODEL}' is not an available VEXZY tool model`,
    )
  }
  return `Worker/subagent model is fixed to ${FIXED_SUBAGENT_MODEL}`
}

export function getSubmodelOptions() {
  const catalog = getDefaultVexzyModelCatalog()
  const registry = catalog.registry
  return catalog
    .getOptions()
    .filter(option => option.value === FIXED_SUBAGENT_MODEL)
    .filter(option => {
      const entry = registry?.get(option.value)
      return entry?.available === true && entry.tools === true && entry.capabilities.tools === true
    })
    .map(option => ({ value: option.value, label: option.displayName, description: option.description }))
}
