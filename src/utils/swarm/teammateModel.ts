import { getConfiguredSubagentModel } from '../model/subagentModel.js'

export function getHardcodedTeammateModelFallback(): string {
  return getConfiguredSubagentModel()
}
