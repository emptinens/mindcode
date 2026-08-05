import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'submodel',
  description: 'Choose the persistent VEXZY model for Workers/subagents',
  argumentHint: '[exact-model-id]',
  load: () => import('./submodel.js'),
} satisfies Command
