import type { Command } from '../../commands.js'

const outputStyle = {
  type: 'local-jsx',
  name: 'output-style',
  description: 'Deprecated: set output style in your settings file',
  isHidden: true,
  load: () => import('./output-style.js'),
} satisfies Command

export default outputStyle
