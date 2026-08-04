import type { Command } from '../../commands.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

const command = {
  name: 'thinking',
  get description() {
    const enabled = getInitialSettings().alwaysThinkingEnabled !== false
    return `Toggle extended thinking (currently ${enabled ? 'on' : 'off'})`
  },
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('./thinking.js'),
} satisfies Command

export default command
