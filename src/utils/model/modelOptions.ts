import {
  type VexzyModelCatalogOption,
  getVexzyModelOptions,
  loadVexzyModelCatalog,
  refreshVexzyModelCatalog,
} from '../../services/api/vexzy/modelCatalog.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import type { ModelSetting } from './model.js'
import { isVexzyModelAllowed } from './modelAllowlist.js'

export type ModelOption = {
  value: ModelSetting
  label: string
  description: string
  descriptionForModel?: string
  displayName?: string
  contextLength?: number
  supportedReasoningEfforts?: readonly string[]
  available?: boolean
  disabled?: boolean
  unavailable?: boolean
}

/**
 * Return only exact model IDs from the ready VEXZY catalog. MindCode has no
 * built-in provider aliases or fallback model list: a cold catalog is empty.
 */
export function getModelOptions(_fastMode = false): ModelOption[] {
  return filterModelOptionsByAllowlist(
    getVexzyModelOptions().map(toModelOption),
  )
}

export async function loadVexzyModelOptions(): Promise<ModelOption[]> {
  await loadVexzyModelCatalog()
  return getModelOptions()
}

export async function refreshVexzyModelOptions(): Promise<ModelOption[]> {
  await refreshVexzyModelCatalog()
  return getModelOptions()
}

function toModelOption(option: VexzyModelCatalogOption): ModelOption {
  return option
}

function filterModelOptionsByAllowlist(options: ModelOption[]): ModelOption[] {
  const settings = getSettings_DEPRECATED() || {}
  return filterModelOptionsByAvailableModels(options, settings.availableModels)
}

export function filterModelOptionsByAvailableModels(
  options: ModelOption[],
  availableModels: readonly string[] | undefined,
): ModelOption[] {
  if (!availableModels) return options
  return options.filter(
    option =>
      option.value !== null &&
      isVexzyModelAllowed(option.value, availableModels),
  )
}
