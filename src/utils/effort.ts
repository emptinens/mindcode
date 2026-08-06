import { getVexzyModelRegistry } from '../services/api/vexzy/modelCatalog.js'
import { type CoreEffortLevel, isPersistableEffort } from './effortCore.js'
import { getInitialSettings } from './settings/settings.js'

export type EffortLevel = CoreEffortLevel

const ADVERTISED_EFFORT_LEVELS = new Set<EffortLevel>([
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
])

export const EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'auto',
] as const satisfies readonly EffortLevel[]

export type EffortValue = EffortLevel | number

export type EffortResolutionScope = 'leader' | 'worker'

export type EffortResolutionOptions = Readonly<{
  scope?: EffortResolutionScope
}>

/** Return the provider's exact advertised order for this catalog model. */
export function getCatalogEffortLevels(model: string): EffortLevel[] {
  const catalogModel = getVexzyModelRegistry()?.get(model)
  if (catalogModel?.available !== true) return []

  const seen = new Set<EffortLevel>()
  return catalogModel.supportedReasoningEfforts.filter(
    (value): value is EffortLevel => {
      if (!ADVERTISED_EFFORT_LEVELS.has(value as EffortLevel)) return false
      const level = value as EffortLevel
      if (seen.has(level)) return false
      seen.add(level)
      return true
    },
  )
}

export function getSupportedEffortLevels(model: string): EffortLevel[] {
  return getCatalogEffortLevels(model)
}

export function modelSupportsCatalogEffort(model: string): boolean {
  return getCatalogEffortLevels(model).length > 0
}

export function modelSupportsCatalogMaxEffort(model: string): boolean {
  return getCatalogEffortLevels(model).includes('max')
}

export function modelSupportsCatalogXhighEffort(model: string): boolean {
  return getCatalogEffortLevels(model).includes('xhigh')
}

export function modelSupportsEffort(model: string): boolean {
  return modelSupportsCatalogEffort(model)
}

export function modelSupportsMaxEffort(model: string): boolean {
  return modelSupportsCatalogMaxEffort(model)
}

export function modelSupportsXhighEffort(model: string): boolean {
  return modelSupportsCatalogXhighEffort(model)
}

export function isEffortLevel(value: string): value is EffortLevel {
  return ADVERTISED_EFFORT_LEVELS.has(value as EffortLevel)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && isValidNumericEffort(value)) return value

  const stringValue = String(value).toLowerCase()
  if (isEffortLevel(stringValue)) return stringValue

  const numericValue = Number.parseInt(stringValue, 10)
  return !Number.isNaN(numericValue) && isValidNumericEffort(numericValue)
    ? numericValue
    : undefined
}

export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | undefined {
  return isPersistableEffort(value) ? value : undefined
}

export function getInitialEffortSetting(): EffortLevel | undefined {
  return toPersistableEffort(getInitialSettings().effortLevel)
}

export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel | undefined,
  priorPersisted: EffortLevel | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

/** `auto` is a provider value; `unset` and `default` clear the override. */
export function getEffortEnvOverride(): EffortValue | null | undefined {
  const raw = process.env.MINDCODE_EFFORT_LEVEL?.toLowerCase()
  if (raw === 'unset' || raw === 'default') return null
  return parseEffortValue(raw)
}

export function getDefaultEffortForModel(
  model: string,
): EffortLevel | undefined {
  const levels = getCatalogEffortLevels(model)
  if (levels.includes('medium')) return 'medium'
  if (levels.includes('auto')) return 'auto'
  return levels[0]
}

/** Resolve the exact value sent to the VEXZY provider. */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
  options: EffortResolutionOptions = {},
): EffortValue | undefined {
  // Leader environment settings are intentionally not visible across the
  // worker/query boundary. Worker effort is assigned by the Leader and must
  // reach the provider unchanged.
  const envOverride =
    options.scope === 'worker' ? undefined : getEffortEnvOverride()
  if (envOverride === null) return undefined

  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  if (typeof resolved !== 'string') return undefined
  return getCatalogEffortLevels(model).includes(resolved)
    ? resolved
    : undefined
}

export function resolveEffortForQuery(
  model: string,
  effortValue: EffortValue | undefined,
  scope: EffortResolutionScope,
): EffortValue | undefined {
  return resolveAppliedEffort(model, effortValue, { scope })
}

export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  return (
    (resolveAppliedEffort(model, appStateEffort) as EffortLevel | undefined) ??
    'auto'
  )
}

export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  const resolved = resolveAppliedEffort(model, effortValue)
  return resolved === undefined
    ? ''
    : ` with ${convertEffortValueToLevel(resolved)} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') return isEffortLevel(value) ? value : 'auto'
  return 'auto'
}

export function getEffortLevelDescription(level: EffortLevel): string {
  switch (level) {
    case 'none':
      return 'No reasoning; fastest direct response'
    case 'minimal':
      return 'Minimal reasoning with the lowest overhead'
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced reasoning for most tasks'
    case 'high':
      return 'Comprehensive reasoning for complex tasks'
    case 'xhigh':
      return 'Very deep reasoning for difficult tasks'
    case 'max':
      return 'Maximum reasoning depth'
    case 'auto':
      return 'Let VEXZY choose the reasoning level'
  }
}

export function getEffortValueDescription(value: EffortValue): string {
  return typeof value === 'string'
    ? getEffortLevelDescription(value)
    : 'Provider-selected reasoning level'
}
