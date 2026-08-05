import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'account',
  description: 'Manage VEXZY accounts and API configs',
  load: () => import('./account.js'),
} satisfies Command
