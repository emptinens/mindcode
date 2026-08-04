import type { Command } from '../../commands.js'

const status = {
  type: 'local-jsx',
  name: 'status',
  description:
    'Show runtime status; use /status html for a detailed session report',
  immediate: true,
  load: () => import('./status.js'),
} satisfies Command

export default status
