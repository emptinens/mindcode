import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getDefaultVexzyModelCatalog, loadVexzyModelCatalog } from '../../services/api/vexzy/modelCatalog.js'
import { getConfiguredSubagentModel, persistSubagentModel } from '../../utils/model/subagentModel.js'

export async function setSubmodel(model: string): Promise<string> {
  const entry = getDefaultVexzyModelCatalog().registry?.get(model)
  if (!entry || !entry.available || !entry.tools || !entry.capabilities.tools) {
    throw new Error(`Model '${model}' is not an available VEXZY tool model`)
  }
  const result = persistSubagentModel(model)
  if (result.error) throw result.error
  return `Worker/subagent model set to ${model}`
}

function SubmodelPicker({ onDone }: { onDone: (message: string) => void }) {
  const current = getConfiguredSubagentModel()
  const options = getDefaultVexzyModelCatalog().getOptions()
    .filter(option => option.available)
    .map(option => ({ value: option.value, label: option.displayName, description: option.description }))
  return <Box flexDirection="column">
    <Text bold>Worker/subagent model</Text>
    <Text dimColor>Leader model is unchanged. Select an exact available VEXZY model.</Text>
    <Select options={options} defaultValue={current} defaultFocusValue={current}
      onChange={(value: string) => { void setSubmodel(value).then(onDone).catch(error => onDone((error as Error).message)) }}
      onCancel={() => onDone(`Kept Worker/subagent model as ${current}`)} />
  </Box>
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  const requested = args.trim()
  if (requested === '--help' || requested === '-h') { onDone('Usage: /submodel [exact-vexzy-model-id]'); return null }
  try {
    await loadVexzyModelCatalog({ refresh: true })
    if (requested) { onDone(await setSubmodel(requested)); return null }
    return <SubmodelPicker onDone={onDone} />
  } catch (error) {
    onDone(`Unable to load VEXZY Worker models: ${(error as Error).message}`)
    return null
  }
}
