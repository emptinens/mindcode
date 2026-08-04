import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'account',
  description: 'Manage Claude accounts and API configs',
  load: () => import('./account.js'),
} satisfies Command
