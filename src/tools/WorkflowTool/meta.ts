// Parse and validate a workflow script's `export const meta = {...}` header.
//
// Contract (from the WorkflowTool prompt): every script MUST begin with
//   export const meta = { name, description, phases? }
// where the object is a PURE LITERAL (no variables, calls, spreads, or template
// interpolation). The body follows and uses agent()/parallel()/pipeline()/...

export type WorkflowPhase = {
  title: string
  detail?: string
  // Worker model is fixed at the subagent admission boundary.
}

export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhase[]
}

export type ParsedWorkflow =
  | { meta: WorkflowMeta; scriptBody: string }
  | { error: string }

/**
 * Find the `export const meta = { ... }` object literal and return both the
 * literal source text and the byte offset just past its closing brace.
 * String- and comment-aware brace matching so braces inside strings/regex
 * don't confuse the scan.
 */
function extractMetaLiteral(
  source: string,
): { literal: string; end: number } | { error: string } {
  const m = /export\s+const\s+meta\s*=\s*\{/.exec(source)
  if (!m) {
    return {
      error:
        '`export const meta = { name, description, phases }` must be the FIRST statement in the script',
    }
  }
  // Reject anything other than whitespace/comments before the meta statement.
  const before = source.slice(0, m.index)
  if (before.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim() !== '') {
    return {
      error: '`export const meta = {...}` must be the FIRST statement',
    }
  }

  const open = m.index + m[0].length - 1 // index of the '{'
  let depth = 0
  let i = open
  let inStr: string | null = null
  for (; i < source.length; i++) {
    const c = source[i]!
    const prev = source[i - 1]
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      inStr = c
      continue
    }
    // skip line comments
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    // skip block comments
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      i = close === -1 ? source.length : close + 1
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        return { literal: source.slice(open, i + 1), end: i + 1 }
      }
    }
  }
  return { error: 'meta object literal is not closed' }
}

/**
 * The meta literal must be pure data — reject the things that would make
 * evaluating it unsafe or non-deterministic (calls, template interpolation,
 * spreads, arrow/function bodies).
 */
function metaLooksImpure(literal: string): boolean {
  const stripped = literal
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
  // a call expression, template literal, spread, or function keyword
  if (/[A-Za-z0-9_$)\]]\s*\(/.test(stripped)) return true
  if (stripped.includes('`')) return true
  if (stripped.includes('...')) return true
  if (/\b(function|=>)\b/.test(stripped)) return true
  return false
}

function validateMeta(value: unknown): WorkflowMeta | { error: string } {
  if (typeof value !== 'object' || value === null) {
    return { error: 'meta must be an object literal' }
  }
  const v = value as Record<string, unknown>
  if (typeof v.name !== 'string' || v.name.trim() === '') {
    return { error: 'meta.name is required and must be a non-empty string' }
  }
  if (typeof v.description !== 'string' || v.description.trim() === '') {
    return { error: 'meta.description is required and must be a string' }
  }
  if (v.whenToUse !== undefined && typeof v.whenToUse !== 'string') {
    return { error: 'meta.whenToUse must be a string' }
  }
  let phases: WorkflowPhase[] | undefined
  if (v.phases !== undefined) {
    if (!Array.isArray(v.phases)) {
      return { error: 'meta.phases must be an array' }
    }
    phases = v.phases.map(p => {
      const pp = (p ?? {}) as Record<string, unknown>
      return {
        title: typeof pp.title === 'string' ? pp.title : '',
        detail: typeof pp.detail === 'string' ? pp.detail : undefined,
        // Worker model is intentionally not accepted from workflow metadata.
      }
    })
  }
  return {
    name: v.name,
    description: v.description,
    whenToUse: typeof v.whenToUse === 'string' ? v.whenToUse : undefined,
    phases,
  }
}

export function parseWorkflowScript(source: string): ParsedWorkflow {
  const extracted = extractMetaLiteral(source)
  if ('error' in extracted) return { error: extracted.error }
  if (metaLooksImpure(extracted.literal)) {
    return {
      error:
        'meta must be a pure literal: no variables, function calls, spreads, or template interpolation',
    }
  }
  let raw: unknown
  try {
    // The literal is verified pure data above, so evaluating it just
    // materializes the object. Runs outside the workflow VM.
    // eslint-disable-next-line no-new-func
    raw = new Function(`"use strict"; return (${extracted.literal});`)()
  } catch (e) {
    return { error: `could not parse meta literal: ${(e as Error).message}` }
  }
  const meta = validateMeta(raw)
  if ('error' in meta) return meta
  return { meta, scriptBody: source.slice(extracted.end) }
}

/**
 * Determinism guard (gb_): Date.now()/Math.random()/argless new Date() break
 * resume, so they are unavailable. Reject inline scripts that reference them.
 */
export function scriptIsNonDeterministic(scriptBody: string): boolean {
  const stripped = scriptBody
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``')
    .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '')
  return (
    /\bDate\s*\.\s*now\s*\(/.test(stripped) ||
    /\bMath\s*\.\s*random\s*\(/.test(stripped) ||
    /\bnew\s+Date\s*\(\s*\)/.test(stripped)
  )
}
