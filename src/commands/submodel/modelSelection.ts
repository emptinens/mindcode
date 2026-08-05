import {
  getDefaultVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import {
  setConfiguredSubagentModel,
} from '../../utils/model/subagentModel.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export async function setSubmodel(model: string): Promise<string> {
  const entry = getDefaultVexzyModelCatalog().registry?.get(model)
  if (!entry || !entry.available || !entry.tools || !entry.capabilities.tools) {
    throw new Error(`Model '${model}' is not an available VEXZY tool model`)
  }
  const result = updateSettingsForSource('userSettings', { subagentModel: model })
  if (result.error) throw result.error
  setConfiguredSubagentModel(model)
  return `Worker/subagent model set to ${model}`
}

export function getSubmodelOptions() {
  const catalog = getDefaultVexzyModelCatalog()
  const registry = catalog.registry
  return catalog.getOptions()
    .filter(option => {
      const entry = registry?.get(option.value)
      return entry?.available === true && entry.tools === true && entry.capabilities.tools === true
    })
    .map(option => ({ value: option.value, label: option.displayName, description: option.description }))
}
