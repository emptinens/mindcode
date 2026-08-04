import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'pin',
  description:
    'Pin a message as persistent session context (Ctrl+P to view pins)',
  argumentHint: '[search text or uuid]',
  immediate: false,
  load: () => import('./pin.js'),
} satisfies Command
