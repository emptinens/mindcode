import type { Command } from '../../commands.js'
import { getJailbreakLevel } from '../../utils/jailbreak.js'

export default {
  type: 'local-jsx',
  name: 'jailbreak',
  get description() {
    return `Set jailbreak level (currently ${getJailbreakLevel()})`
  },
  argumentHint: '[disabled|lowered|full]',
  load: () => import('./jailbreak.js'),
} satisfies Command
