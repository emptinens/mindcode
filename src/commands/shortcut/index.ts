import type { Command } from '../../commands.js'
import type { LocalCommandCall } from '../../types/command.js'
import {
  addShortcut,
  getPromptShortcuts,
  getShortcutsFilePath,
  isValidShortcutName,
  removeShortcut,
} from '../../utils/promptShortcuts.js'

function listText(): string {
  const shortcuts = getPromptShortcuts()
  const names = Object.keys(shortcuts).sort()
  if (names.length === 0) {
    return [
      'No prompt shortcuts defined.',
      'Add one with: /shortcut add <name> <template>',
      'Then type ".<name> your message" to expand it. Use {input} in the',
      "template to place your message; otherwise it's appended.",
      `File: ${getShortcutsFilePath()}`,
    ].join('\n')
  }
  const lines = names.map(name => {
    const tmpl = shortcuts[name]!.replace(/\s+/g, ' ').trim()
    const preview = tmpl.length > 80 ? `${tmpl.slice(0, 80)}…` : tmpl
    return `  .${name} — ${preview}`
  })
  return [`Prompt shortcuts (${names.length}):`, ...lines].join('\n')
}

const call: LocalCommandCall = async args => {
  const trimmed = args.trim()
  if (!trimmed) {
    return { type: 'text', value: listText() }
  }

  const spaceIndex = trimmed.indexOf(' ')
  const sub = (spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex))
    .toLowerCase()
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim()

  if (sub === 'list') {
    return { type: 'text', value: listText() }
  }

  if (sub === 'add') {
    const nameSpace = rest.indexOf(' ')
    const name = nameSpace === -1 ? rest : rest.slice(0, nameSpace)
    const template = nameSpace === -1 ? '' : rest.slice(nameSpace + 1).trim()
    if (!name || !template) {
      return {
        type: 'text',
        value: 'Usage: /shortcut add <name> <template>',
      }
    }
    if (!isValidShortcutName(name)) {
      return {
        type: 'text',
        value: `Invalid shortcut name "${name}". Use letters, digits, _ or - only.`,
      }
    }
    const existed = name in getPromptShortcuts()
    addShortcut(name, template)
    return {
      type: 'text',
      value: `${existed ? 'Updated' : 'Added'} shortcut ".${name}". Type ".${name} your message" to use it.`,
    }
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = rest.split(' ')[0] ?? ''
    if (!name) {
      return { type: 'text', value: 'Usage: /shortcut remove <name>' }
    }
    const removed = removeShortcut(name)
    return {
      type: 'text',
      value: removed
        ? `Removed shortcut ".${name}".`
        : `No shortcut named ".${name}".`,
    }
  }

  return {
    type: 'text',
    value: [
      `Unknown subcommand "${sub}".`,
      'Usage:',
      '  /shortcut list',
      '  /shortcut add <name> <template>',
      '  /shortcut remove <name>',
    ].join('\n'),
  }
}

const shortcut = {
  type: 'local',
  name: 'shortcut',
  description: 'Manage prompt shortcuts (.<name> expands a saved template)',
  argumentHint: '[list | add <name> <template> | remove <name>]',
  supportsNonInteractive: true,
  load: () => Promise.resolve({ call }),
} satisfies Command

export default shortcut
