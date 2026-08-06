import type { LocalJSXCommandCall } from '../../types/command.js'
import { FIXED_SUBAGENT_MODEL } from '../../utils/model/subagentModel.js'
import {
  ensureSubmodelCatalogReady,
  setSubmodel,
} from './modelSelection.js'

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const requested = args.trim()
  if (requested === '--help' || requested === '-h') { onDone('Usage: /submodel [gpt-5.6-luna]'); return null }
  try {
    await ensureSubmodelCatalogReady()
  } catch (error) {
    onDone(`Unable to load VEXZY Worker models: ${(error as Error).message}`)
    return null
  }
  try {
    onDone(await setSubmodel(requested || FIXED_SUBAGENT_MODEL))
  } catch (error) {
    onDone((error as Error).message)
  }
  return null
}
