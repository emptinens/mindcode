import type { Command } from '../../commands.js'

const folder = {
  type: 'local',
  name: 'folder',
  description: 'Open the current working directory in file explorer',
  load: () => import('./folder.js'),
} satisfies Command

export default folder
