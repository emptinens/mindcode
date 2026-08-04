export type PaneTeammateTerminalStatus = 'completed' | 'killed'

export function getPaneTeammateTerminalPatch(
  task: {
    type: string
    status: string
    identity?: { agentId?: string }
  },
  agentId: string,
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
    task.identity?.agentId !== agentId ||
    task.status !== 'running'
  ) {
    return undefined
  }
  return { status: terminalStatus, endTime, isIdle: false }
}
