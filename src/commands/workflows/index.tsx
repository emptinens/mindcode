// /workflows — view and manage running/completed dynamic workflows.
// Opens the background-tasks dialog (which renders the workflow detail view,
// progress tree, and stop/skip/retry controls for local_workflow tasks).

import React from 'react'
import type { Command } from '../../types/command.js'
import { isWorkflowsEnabled } from '../../tools/WorkflowTool/gate.js'

const workflowsCommand: Command = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'View and manage running dynamic workflows',
  isEnabled: () => isWorkflowsEnabled(),
  userInvocable: true,
  async load() {
    return {
      async call(onDone, context) {
        const { BackgroundTasksDialog } = await import(
          '../../components/tasks/BackgroundTasksDialog.js'
        )
        return React.createElement(BackgroundTasksDialog, {
          onDone,
          toolUseContext: context,
        })
      },
    }
  },
}

export default workflowsCommand
