// User-defined prompt shortcuts. Typing ".<name> <text>" in the prompt expands
// to a stored template (with the user's text substituted/appended) before the
// message is sent to the model. Templates are NOT hardcoded — they live in a
// JSON map the user can edit directly or manage via the /shortcut command.
//
// File: <claude config dir>/shortcuts.json  e.g. { "q": "Answer only..." }
import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getMindCodeConfigHomeDir } from './envUtils.js'
import { logError } from './log.js'

export type PromptShortcuts = Record<string, string>

// A shortcut name is a short token: letters, digits, underscore, dash.
const SHORTCUT_NAME_RE = /^[a-zA-Z0-9_-]+$/
// Placeholder a template may use to position the user's text. When absent, the
// user's text is appended after the template.
const INPUT_PLACEHOLDER = '{input}'

export function getShortcutsFilePath(): string {
  return join(getMindCodeConfigHomeDir(), 'shortcuts.json')
}

export function isValidShortcutName(name: string): boolean {
  return SHORTCUT_NAME_RE.test(name)
}

// mtime-keyed cache: re-read only when the file changes, so edits apply live
// without a restart but we don't hit disk on every keystroke/submit.
let cache: { mtimeMs: number; shortcuts: PromptShortcuts } | null = null

export function getPromptShortcuts(): PromptShortcuts {
  const file = getShortcutsFilePath()
  let mtimeMs: number
  try {
    if (!existsSync(file)) {
      cache = null
      return {}
    }
    mtimeMs = statSync(file).mtimeMs
  } catch {
    return cache?.shortcuts ?? {}
  }

  if (cache && cache.mtimeMs === mtimeMs) {
    return cache.shortcuts
  }

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as unknown
    const shortcuts: PromptShortcuts = {}
    if (parsed && typeof parsed === 'object') {
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string' && isValidShortcutName(k)) {
          shortcuts[k] = v
        }
      }
    }
    cache = { mtimeMs, shortcuts }
    return shortcuts
  } catch (e) {
    logError(e)
    return cache?.shortcuts ?? {}
  }
}

export function savePromptShortcuts(shortcuts: PromptShortcuts): void {
  const file = getShortcutsFilePath()
  writeFileSync(file, `${JSON.stringify(shortcuts, null, 2)}\n`, 'utf-8')
  // Invalidate immediately so the next read reflects the write.
  cache = null
}

/** Add or overwrite a shortcut. Returns false if the name is invalid. */
export function addShortcut(name: string, template: string): boolean {
  if (!isValidShortcutName(name)) {
    return false
  }
  const shortcuts = getPromptShortcuts()
  shortcuts[name] = template
  savePromptShortcuts(shortcuts)
  return true
}

/** Remove a shortcut. Returns true if it existed. */
export function removeShortcut(name: string): boolean {
  const shortcuts = getPromptShortcuts()
  if (!(name in shortcuts)) {
    return false
  }
  delete shortcuts[name]
  savePromptShortcuts(shortcuts)
  return true
}

/**
 * If `input` begins with ".<name>" where <name> is a registered shortcut,
 * expand it: substitute the user's remaining text into the template's
 * {input} placeholder, or append it after the template when there's no
 * placeholder. Returns null when the input isn't a registered shortcut (so the
 * caller leaves it as plain text — ".gitignore", "...", ".5" never expand).
 */
export function expandShortcut(input: string): string | null {
  if (!input.startsWith('.')) {
    return null
  }
  // Split ".name rest-of-message" — name is the first whitespace-delimited token.
  const match = input.slice(1).match(/^([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/)
  if (!match) {
    return null
  }
  const name = match[1]!
  const body = (match[2] ?? '').trim()

  const shortcuts = getPromptShortcuts()
  const template = shortcuts[name]
  if (template === undefined) {
    return null
  }

  if (template.includes(INPUT_PLACEHOLDER)) {
    return template.split(INPUT_PLACEHOLDER).join(body)
  }
  return body ? `${template}\n\n${body}` : template
}
