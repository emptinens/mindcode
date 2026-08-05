import { getVexzyModelCatalogState } from '../../services/api/vexzy/modelCatalog.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'

/**
 * VEXZY model IDs are opaque, case-sensitive provider identifiers. The
 * catalog is authoritative; no family, prefix, alias, or provider translation
 * is performed locally.
 */
export function isVexzyModelAllowed(
  model: string,
  availableModels: readonly string[] | undefined =
    getSettings_DEPRECATED()?.availableModels,
): boolean {
  if (availableModels !== undefined) {
    return availableModels.some(candidate => candidate.trim() === model)
  }

  const catalog = getVexzyModelCatalogState()
  if (catalog.state !== 'ready' || catalog.registry === undefined) {
    return false
  }
  return catalog.registry.get(model)?.available === true
}

/**
 * Compatibility name used by settings and command callers. It intentionally
 * applies only exact catalog IDs and never expands a legacy alias.
 */
export function isModelAllowed(model: string): boolean {
  return isVexzyModelAllowed(model)
}
