// Exposes saved/built-in workflows as slash commands (e.g. /deep-research).
// Each command is a thin prompt that asks the model to run the named workflow.

import type { Command } from '../../types/command.js'
import { WORKFLOW_TOOL_NAME } from './constants.js'
import { isWorkflowsEnabled } from './gate.js'
import { listWorkflows } from './registry.js'

export async function getWorkflowCommands(_cwd: string): Promise<Command[]> {
  if (!isWorkflowsEnabled()) return []
  return listWorkflows().map(wf => {
    const cmd: Command = {
      type: 'prompt',
      name: wf.name,
      description: wf.description,
      progressMessage: `running the ${wf.name} workflow`,
      contentLength: wf.description.length,
      source: 'bundled',
      kind: 'workflow',
      argumentHint: '[args]',
      userInvocable: true,
      isEnabled: () => isWorkflowsEnabled(),
      async getPromptForCommand(args: string) {
        const argTrim = args?.trim()
        const text =
          `Run the "${wf.name}" workflow${argTrim ? ` with args: ${JSON.stringify(argTrim)}` : ''}. ` +
          `Use the ${WORKFLOW_TOOL_NAME} tool: ${WORKFLOW_TOOL_NAME}({ name: ${JSON.stringify(wf.name)}` +
          `${argTrim ? `, args: ${JSON.stringify(argTrim)}` : ''} }).`
        return [{ type: 'text', text }]
      },
    }
    return cmd
  })
}
