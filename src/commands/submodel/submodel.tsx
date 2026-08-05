import * as React from 'react'
import { Box, Text } from '../../ink.js'
import { Select } from '../../components/CustomSelect/index.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getConfiguredSubagentModel } from '../../utils/model/subagentModel.js'
import {
  ensureSubmodelCatalogReady,
  getSubmodelOptions,
  setSubmodel,
} from './modelSelection.js'

function SubmodelPicker({ onDone }: { onDone: (message: string) => void }) {
  const current = getConfiguredSubagentModel()
  const options = getSubmodelOptions()
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
    await ensureSubmodelCatalogReady()
    if (requested) { onDone(await setSubmodel(requested)); return null }
    return <SubmodelPicker onDone={onDone} />
  } catch (error) {
    onDone(`Unable to load VEXZY Worker models: ${(error as Error).message}`)
    return null
  }
}
