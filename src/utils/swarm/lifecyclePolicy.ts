export type PaneTeammateTerminalStatus = 'completed' | 'failed' | 'killed'

/**
 * Immutable identity of a running pane task captured before asynchronous
 * teardown begins. `taskKey` protects the AppState map entry; `taskId` and
 * `startTime` protect the task generation stored at that key.
 */
export type PaneTaskTerminalTarget = Readonly<{
  taskKey: string
  taskId: string
  startTime: number
  agentId: string
}>

export function getPaneTeammateTerminalPatch(
  task: {
    id?: string
    type: string
    status: string
    startTime?: number
    identity?: { agentId?: string }
  },
  target: PaneTaskTerminalTarget,
  terminalStatus: PaneTeammateTerminalStatus,
  endTime = Date.now(),
):
  | {
      status: PaneTeammateTerminalStatus
      endTime: number
      isIdle: false
    }
  | undefined {
  if (
    task.type !== 'in_process_teammate' ||
    task.identity?.agentId !== target.agentId ||
    task.id !== target.taskId ||
    task.startTime !== target.startTime ||
    task.status !== 'running'
  ) {
    return undefined
  }
  return { status: terminalStatus, endTime, isIdle: false }
}
