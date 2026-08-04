import { toolMatchesName } from '../../Tool.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../ExitWorktreeTool/constants.js'

/**
 * Worktree lifecycle belongs to AgentTool, not to the worker model. Keeping
 * these tools out of a worker prevents it from creating nested isolation or
 * retrying a worktree that the human did not request.
 */
export function filterWorkerTools<
  T extends { name: string; aliases?: string[] },
>(tools: readonly T[]): T[] {
  return tools.filter(
    tool =>
      !toolMatchesName(tool, ENTER_WORKTREE_TOOL_NAME) &&
      !toolMatchesName(tool, EXIT_WORKTREE_TOOL_NAME),
  )
}
