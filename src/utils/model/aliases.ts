/**
 * Model identifiers are owned by the VEXZY `/models` response.
 *
 * Keep this compatibility module because a few public tool contracts still
 * carry the historical `ModelAlias` type, but do not define or resolve any
 * built-in model aliases here. An identifier only becomes selectable after it
 * is returned by the ready VEXZY catalog.
 */
export type ModelAlias = string

export const MODEL_ALIASES: readonly [] = []
export const MODEL_FAMILY_ALIASES: readonly [] = []

export function isModelAlias(_modelInput: string): _modelInput is ModelAlias {
  return false
}

export function isModelFamilyAlias(_model: string): boolean {
  return false
}
