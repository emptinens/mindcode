import { getMainLoopModelOverride } from '../../bootstrap/state.js'
import {
  getVexzyModelCatalogState,
} from '../../services/api/vexzy/modelCatalog.js'
import { VEXZY_FIXED_WORKER_MODEL } from '../../services/api/vexzy/modelRegistry.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { isModelAllowed } from './modelAllowlist.js'
import type { ModelAlias } from './aliases.js'
import { has1mContext, modelSupports1M } from '../context.js'

export type ModelShortName = string
export type ModelName = string
export type ModelSetting = ModelName | ModelAlias | null

function stripContextSuffix(model: string): string {
  return model.replace(/\[(?:1|2)m\]$/i, '')
}

function getReadyModels() {
  return getVexzyModelCatalogState().registry?.models ?? []
}

/** Select the first available exact ID from the provider catalog. */
function getCatalogDefaultModel(): ModelName {
  const models = getReadyModels().filter(model => model.available)
  const worker = models.find(model => model.id === VEXZY_FIXED_WORKER_MODEL)
  return worker?.id ?? models[0]?.id ?? VEXZY_FIXED_WORKER_MODEL
}

export function getSmallFastModel(): ModelName {
  return process.env.MINDCODE_SMALL_FAST_MODEL?.trim() || getCatalogDefaultModel()
}

/** Compatibility predicate retained for retry policy; all ready catalog models are non-custom. */
export function isNonCustomOpusModel(model: ModelName): boolean {
  return getReadyModels().some(
    entry => entry.available && entry.id === stripContextSuffix(model),
  )
}

/**
 * Return the exact user-selected VEXZY ID. The catalog is checked when ready;
 * before startup catalog loading, the value is preserved so the startup
 * loader can validate it without lowercasing or translating it.
 */
export function getUserSpecifiedModelSetting(): ModelSetting | undefined {
  const modelOverride = getMainLoopModelOverride()
  const settings = getSettings_DEPRECATED() || {}
  const specifiedModel =
    modelOverride !== undefined
      ? modelOverride
      : process.env.MINDCODE_MODEL || settings.model || undefined

  if (!specifiedModel) return undefined

  const catalogState = getVexzyModelCatalogState()
  if (catalogState.state === 'ready' && !isModelAllowed(specifiedModel)) {
    return undefined
  }
  return specifiedModel
}

export function getMainLoopModel(): ModelName {
  const model = getUserSpecifiedModelSetting()
  return model === undefined || model === null
    ? getDefaultMainLoopModel()
    : parseUserSpecifiedModel(model)
}

export function getBestModel(): ModelName {
  return getCatalogDefaultModel()
}

/** Compatibility role helpers now resolve through the same dynamic catalog. */
export function getDefaultOpusModel(): ModelName {
  return getCatalogDefaultModel()
}

export function getDefaultSonnetModel(): ModelName {
  return getCatalogDefaultModel()
}

export function getDefaultHaikuModel(): ModelName {
  return getCatalogDefaultModel()
}

export function getRuntimeMainLoopModel(params: {
  permissionMode: PermissionMode
  mainLoopModel: string
  exceeds200kTokens?: boolean
}): ModelName {
  return params.mainLoopModel
}

export function getDefaultMainLoopModelSetting(): ModelName | ModelAlias {
  return getCatalogDefaultModel()
}

export function getDefaultMainLoopModel(): ModelName {
  return parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
}

/**
 * Provider-neutral canonicalization. Dynamic VEXZY IDs are opaque and must not
 * be renamed; only the client-only context suffix is removed.
 */
export function firstPartyNameToCanonical(name: ModelName): ModelShortName {
  return stripContextSuffix(name)
}

export function getCanonicalName(fullModelName: ModelName): ModelShortName {
  return firstPartyNameToCanonical(fullModelName)
}

export function getClaudeAiUserDefaultModelDescription(
  _fastMode = false,
): string {
  return `VEXZY default · ${renderModelName(getCatalogDefaultModel())}`
}

export function renderDefaultModelSetting(
  setting: ModelName | ModelAlias,
): string {
  return renderModelName(parseUserSpecifiedModel(setting))
}

/** VEXZY publishes model pricing dynamically; no provider price table is bundled. */
export function getOpus48PricingSuffix(_fastMode: boolean): string {
  return ''
}

/** Legacy subscription-based 1M merge is not part of VEXZY model selection. */
export function isOpus1mMergeEnabled(): boolean {
  return false
}

export function renderModelSetting(setting: ModelName | ModelAlias): string {
  return renderModelName(setting)
}

export function getPublicModelDisplayName(model: ModelName): string | null {
  const base = stripContextSuffix(model)
  const catalogModel = getVexzyModelCatalogState().registry?.get(base)
  if (!catalogModel) return null
  const suffix = has1mContext(model) ? ' (1M context)' : ''
  return `${catalogModel.displayName}${suffix}`
}

export function renderModelName(model: ModelName): string {
  return getPublicModelDisplayName(model) ?? model
}

export function getPublicModelName(model: ModelName): string {
  return `MindCode ${renderModelName(model)}`
}

/**
 * Resolve a model input without aliases or provider-specific rewrites.
 * Exact case and every provider-owned character are preserved.
 */
export function parseUserSpecifiedModel(modelInput: ModelName | ModelAlias): ModelName {
  const trimmed = modelInput.trim()
  return stripContextSuffix(trimmed) +
    (has1mContext(trimmed) ? '[1m]' : '')
}

export function resolveSkillModelOverride(
  skillModel: string,
  currentModel: string,
): string {
  if (has1mContext(skillModel) || !has1mContext(currentModel)) {
    return skillModel
  }
  const target = stripContextSuffix(skillModel)
  return modelSupports1M(target) ? `${target}[1m]` : skillModel
}

/** Legacy model migration is intentionally disabled for opaque VEXZY IDs. */
export function isLegacyModelRemapEnabled(): boolean {
  return false
}

export function modelDisplayString(model: ModelSetting): string {
  if (model === null) {
    return `Default (${renderModelName(getDefaultMainLoopModel())})`
  }
  const resolvedModel = parseUserSpecifiedModel(model)
  return model === resolvedModel ? resolvedModel : `${model} (${resolvedModel})`
}

export function getMarketingNameForModel(modelId: string): string | undefined {
  return getPublicModelDisplayName(modelId) ?? undefined
}

export function normalizeModelStringForAPI(model: string): string {
  return model.replace(/\[(1|2)m\]/gi, '')
}
