// Autocomplete for prompt shortcuts. When the input starts with ".", suggest
// registered shortcut names (analogous to "/" command suggestions).
import type { SuggestionItem } from '../../components/PromptInput/PromptInputFooterSuggestions.js'
import { getPromptShortcuts } from '../promptShortcuts.js'

/** True when the input is a bare ".name" token (no body yet) eligible for suggestions. */
export function isShortcutInput(input: string): boolean {
  // "." or ".partialName" with no space yet (once the user types a space they're
  // writing the message body, so stop suggesting).
  return /^\.[a-zA-Z0-9_-]*$/.test(input)
}

/** Build suggestion items for the registered shortcuts matching the ".partial" input. */
export function generateShortcutSuggestions(input: string): SuggestionItem[] {
  if (!isShortcutInput(input)) {
    return []
  }
  const query = input.slice(1).toLowerCase()
  const shortcuts = getPromptShortcuts()

  return Object.keys(shortcuts)
    .filter(name => name.toLowerCase().startsWith(query))
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
    .map(name => {
      const tmpl = shortcuts[name]!.replace(/\s+/g, ' ').trim()
      const preview = tmpl.length > 80 ? `${tmpl.slice(0, 80)}…` : tmpl
      return {
        id: `shortcut-${name}`,
        displayText: `.${name}`,
        description: preview,
        metadata: { shortcutName: name },
      }
    })
}

/** Extract the shortcut name from a shortcut suggestion item, if it is one. */
export function getShortcutName(item: SuggestionItem): string | null {
  const meta = item.metadata
  if (
    meta &&
    typeof meta === 'object' &&
    'shortcutName' in meta &&
    typeof (meta as { shortcutName: unknown }).shortcutName === 'string'
  ) {
    return (meta as { shortcutName: string }).shortcutName
  }
  return null
}
