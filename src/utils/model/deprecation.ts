/**
 * VEXZY owns model availability and retirement metadata in the dynamic
 * catalog. No local model deprecation table is maintained.
 */
export function getModelDeprecationWarning(
  _modelId: string | null,
): string | null {
  return null
}
