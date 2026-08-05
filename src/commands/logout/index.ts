import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: 'Clear MindCode VEXZY authentication state',
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  load: () => import('./logout.js'),
} satisfies Command
