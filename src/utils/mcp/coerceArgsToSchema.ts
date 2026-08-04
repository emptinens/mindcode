import type { ToolInputJSONSchema } from '../../Tool.js'

/**
 * Coerce quoted numeric/boolean string literals in MCP tool arguments to match
 * the server's declared JSON Schema types.
 *
 * Built-in tools wrap typed params in semanticNumber()/semanticBoolean(), which
 * coerce `"5"` → 5 and `"true"` → true before validation. MCP tools get none of
 * that: their client-side schema is `z.object({}).passthrough()`, so a quoted
 * `"count":"5"` passes straight through and the MCP *server's* Zod schema then
 * rejects it with an invalid_type error. This walks the server's inputJSONSchema
 * and applies the same tolerant coercion the built-ins already enjoy.
 *
 * Coercion philosophy (matches semanticNumber): only strings that are valid
 * decimal/integer literals or "true"/"false" are coerced; anything else passes
 * through untouched so the server still rejects genuinely malformed input.
 *
 * Guard: if `string` is also an allowed type for a field, the value is already
 * valid as-is and is left alone — coercing it could change the intended shape.
 */

const NUMBER_LITERAL = /^-?\d+(\.\d+)?$/
const INTEGER_LITERAL = /^-?\d+$/

type JsonSchema = {
  type?: unknown
  properties?: unknown
  items?: unknown
  anyOf?: unknown
  oneOf?: unknown
  [x: string]: unknown
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeTypes(type: unknown): string[] {
  if (typeof type === 'string') return [type]
  if (Array.isArray(type))
    return type.filter((t): t is string => typeof t === 'string')
  return []
}

/** Collect the candidate subschemas for a value: the node itself plus anyOf/oneOf branches. */
function candidateSchemas(schema: JsonSchema): JsonSchema[] {
  const out: JsonSchema[] = [schema]
  for (const key of ['anyOf', 'oneOf'] as const) {
    const branches = schema[key]
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (isPlainObject(branch)) out.push(branch as JsonSchema)
      }
    }
  }
  return out
}

/**
 * Coerce a single scalar value according to the union of types declared across
 * the candidate schemas. Returns the original value if no safe coercion applies.
 */
function coerceScalar(value: string, schemas: JsonSchema[]): unknown {
  const types = new Set<string>()
  for (const s of schemas) for (const t of normalizeTypes(s.type)) types.add(t)

  // If the server accepts a string here, the value is already valid. Coercing
  // would risk changing intent (e.g. an id that happens to be all digits).
  if (types.has('string')) return value

  if ((types.has('integer') || types.has('number')) && NUMBER_LITERAL.test(value)) {
    // Reject a fractional literal for an integer-only field; let the server error.
    if (types.has('integer') && !types.has('number') && !INTEGER_LITERAL.test(value)) {
      return value
    }
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }

  if (types.has('boolean')) {
    if (value === 'true') return true
    if (value === 'false') return false
  }

  return value
}

function coerceValue(value: unknown, schema: JsonSchema): unknown {
  const schemas = candidateSchemas(schema)

  if (typeof value === 'string') {
    return coerceScalar(value, schemas)
  }

  if (Array.isArray(value)) {
    // Find an items schema among the candidates (single-schema form only).
    const itemsSchema = schemas
      .map(s => s.items)
      .find(isPlainObject) as JsonSchema | undefined
    if (!itemsSchema) return value
    return value.map(el => coerceValue(el, itemsSchema))
  }

  if (isPlainObject(value)) {
    // Merge property maps from all candidate object schemas.
    let changed = false
    const result: Record<string, unknown> = { ...value }
    for (const s of schemas) {
      const props = s.properties
      if (!isPlainObject(props)) continue
      for (const [key, propSchema] of Object.entries(props)) {
        if (!(key in result) || !isPlainObject(propSchema)) continue
        const coerced = coerceValue(result[key], propSchema as JsonSchema)
        if (coerced !== result[key]) {
          result[key] = coerced
          changed = true
        }
      }
    }
    return changed ? result : value
  }

  return value
}

/**
 * Walk `args` against the tool's JSON Schema, coercing quoted numeric/boolean
 * string literals to their declared types. Pure and non-mutating: returns a new
 * object only when something changed, otherwise the original reference.
 */
export function coerceArgsToSchema(
  args: Record<string, unknown>,
  schema: ToolInputJSONSchema | undefined,
): Record<string, unknown> {
  if (!schema || !isPlainObject(schema.properties)) return args

  let changed = false
  const result: Record<string, unknown> = { ...args }
  for (const [key, propSchema] of Object.entries(schema.properties)) {
    if (!(key in result) || !isPlainObject(propSchema)) continue
    const coerced = coerceValue(result[key], propSchema as JsonSchema)
    if (coerced !== result[key]) {
      result[key] = coerced
      changed = true
    }
  }
  return changed ? result : args
}
