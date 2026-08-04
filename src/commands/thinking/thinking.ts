import type { LocalCommandCall } from '../../types/command.js'
import { updateSettingsForSource } from '../../utils/settings/settings.js'

export const call: LocalCommandCall = async (_args, context) => {
  const current = context.getAppState().thinkingEnabled ?? true
  const next = !current

  context.setAppState(prev => ({ ...prev, thinkingEnabled: next }))
  updateSettingsForSource('userSettings', {
    alwaysThinkingEnabled: next ? undefined : false,
  })

  return {
    type: 'text',
    value: `Thinking ${next ? 'enabled' : 'disabled'}.`,
  }
}
