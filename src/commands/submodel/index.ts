import type { Command } from '../../commands.js'

export default {
  type: 'local-jsx',
  name: 'submodel',
  description: 'Show the fixed VEXZY model for Workers/subagents',
  argumentHint: '[gpt-5.6-luna]',
  load: () => import('./submodel.js'),
} satisfies Command
