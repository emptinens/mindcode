import { toJSONSchema, type ZodTypeAny } from 'zod/v4'

/**
 * Convert a settings input schema to JSON Schema for documentation/tools.
 *
 * Settings parsing accepts a few runtime-only undefined branches while
 * merging optional values. JSON Schema cannot encode undefined, so Zod must
 * emit `any` for those branches instead of throwing during Skill rendering.
 */
export function toSettingsJSONSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
  }) as Record<string, unknown>
}
