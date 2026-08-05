import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description: 'Generate a detailed local session report; use /status ui for the panel',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
