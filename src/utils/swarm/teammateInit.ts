/**
 * Teammate Initialization Module
 *
 * Handles initialization for MindCode instances running as teammates in a swarm.
 * Registers a Stop hook to notify the team leader when the teammate becomes idle.
 */

import { randomUUID } from 'node:crypto'
import { getCompiledWorkerPolicySnapshot } from '../../services/policy/workerPolicySource.js'
import {
  parsePolicyEpochEnvironment,
  readCurrentPolicyEpochState,
} from '../../services/policy/index.js'
import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../debug.js'
import { addFunctionHook } from '../hooks/sessionHooks.js'
import { applyPermissionUpdate } from '../permissions/PermissionUpdate.js'
import { getTeammateColor } from '../teammate.js'
import { createIdleNotification, writeToMailbox } from '../teammateMailbox.js'
import {
  resolveWorkerRuntime,
  type WorkerEffortInput,
} from './backends/types.js'
import { readTeamFile, setMemberActive } from './teamHelpers.js'
import {
  buildWorkerTeamReportFromMessages,
  isWorkerReportCompletionEligible,
  serializeWorkerTeamReportMessage,
} from './workerTeamReport.js'

export const WORKER_LIFECYCLE_RUN_ID_ENV = 'MINDCODE_WORKER_RUN_ID'

function resolveWorkerPolicySnapshot() {
  const snapshot = getCompiledWorkerPolicySnapshot()
  const inherited = parsePolicyEpochEnvironment()
  if (
    inherited &&
    (inherited.epoch !== snapshot.policyEpoch ||
      inherited.digest !== snapshot.sourceDigest)
  ) {
    throw new Error('Inherited Worker policy epoch/digest mismatch')
  }
  const persisted = readCurrentPolicyEpochState()
  if (
    inherited &&
    persisted &&
    (persisted.epoch !== inherited.epoch ||
      persisted.digest !== inherited.digest)
  ) {
    throw new Error('Inherited Worker policy epoch is stale')
  }
  return snapshot
}

/** Creates an opaque run identifier for one Worker process lifecycle. */
export function createWorkerLifecycleRunId(): string {
  return `worker-lifecycle:${randomUUID()}`
}

export function resolveTeammateWorkerEffort(
  explicit: WorkerEffortInput | undefined,
  argv: readonly string[] = process.argv,
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  const effortFlagIndex = argv.indexOf('--effort')
  const cliEffort = effortFlagIndex >= 0 ? argv[effortFlagIndex + 1] : undefined
  // Legacy startup compatibility only. Spawn/runtime paths pass the resolved
  // effort explicitly and never forward or re-read this environment value.
  return resolveWorkerRuntime(
    explicit ?? cliEffort ?? environment.MINDCODE_WORKER_EFFORT,
  ).effort
}

/**
 * Initializes hooks for a teammate running in a swarm.
 * Should be called early in session startup after AppState is available.
 *
 * Registers a Stop hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export function initializeTeammateHooks(
  setAppState: (updater: (prev: AppState) => AppState) => void,
  sessionId: string,
  teamInfo: {
    teamName: string
    agentId: string
    agentName: string
    taskId?: string
    effort?: WorkerEffortInput
  },
): void {
  const { teamName, agentId, agentName } = teamInfo

  // Read team file to get leader ID
  const teamFile = readTeamFile(teamName)
  if (!teamFile) {
    logForDebugging(`[TeammateInit] Team file not found for team: ${teamName}`)
    return
  }

  const leadAgentId = teamFile.leadAgentId
  const workerPolicy = resolveWorkerPolicySnapshot()
  const reportTaskId = teamInfo.taskId ?? agentId
  const workerRunId =
    process.env[WORKER_LIFECYCLE_RUN_ID_ENV] ?? createWorkerLifecycleRunId()
  const workerEffort = resolveTeammateWorkerEffort(teamInfo.effort)

  // Apply team-wide allowed paths if any exist
  if (teamFile.teamAllowedPaths && teamFile.teamAllowedPaths.length > 0) {
    logForDebugging(
      `[TeammateInit] Found ${teamFile.teamAllowedPaths.length} team-wide allowed path(s)`,
    )

    for (const allowedPath of teamFile.teamAllowedPaths) {
      // For absolute paths (starting with /), prepend one / to create //path/** pattern
      // For relative paths, just use path/**
      const ruleContent = allowedPath.path.startsWith('/')
        ? `/${allowedPath.path}/**`
        : `${allowedPath.path}/**`

      logForDebugging(
        `[TeammateInit] Applying team permission: ${allowedPath.toolName} allowed in ${allowedPath.path} (rule: ${ruleContent})`,
      )

      setAppState((prev) => ({
        ...prev,
        toolPermissionContext: applyPermissionUpdate(
          prev.toolPermissionContext,
          {
            type: 'addRules',
            rules: [
              {
                toolName: allowedPath.toolName,
                ruleContent,
              },
            ],
            behavior: 'allow',
            destination: 'session',
          },
        ),
      }))
    }
  }

  // Find the leader's name from the members array
  const leadMember = teamFile.members.find((m) => m.agentId === leadAgentId)
  const leadAgentName = leadMember?.name || 'team-lead'

  // Don't register hook if this agent is the leader
  if (agentId === leadAgentId) {
    logForDebugging(
      '[TeammateInit] This agent is the team leader - skipping idle notification hook',
    )
    return
  }

  logForDebugging(
    `[TeammateInit] Registering Stop hook for teammate ${agentName} to notify leader ${leadAgentName}`,
  )

  // Register Stop hook to notify leader when this teammate stops
  addFunctionHook(
    setAppState,
    sessionId,
    'Stop',
    '', // No matcher - applies to all Stop events
    async (messages, _signal) => {
      // Mark this teammate as idle in the team config (fire and forget)
      void setMemberActive(teamName, agentName, false)

      // The Stop hook has no independent file watcher. changed_files therefore
      // comes only from valid JSON in the final assistant text; malformed or
      // free-form output falls back to changed_files: [] plus bounded evidence.
      // Earlier transcript content is used only for deduplicated usage totals.
      const report = buildWorkerTeamReportFromMessages({
        taskId: reportTaskId,
        runId: workerRunId,
        workerId: agentId,
        policyEpoch: workerPolicy.policyEpoch,
        effortUsed: workerEffort,
        messages,
      })

      // Send idle notification to the team leader using agent name (not UUID)
      // Must await to ensure the write completes before process shutdown
      const notification = createIdleNotification(agentName, {
        idleReason: isWorkerReportCompletionEligible(report)
          ? 'available'
          : 'failed',
        report,
      })
      await writeToMailbox(leadAgentName, {
        from: agentName,
        text: serializeWorkerTeamReportMessage(notification),
        timestamp: new Date().toISOString(),
        color: getTeammateColor(),
      })
      logForDebugging(
        `[TeammateInit] Sent idle notification to leader ${leadAgentName}`,
      )
      return true // Don't block the Stop
    },
    'Failed to send idle notification to team leader',
    {
      timeout: 10000,
    },
  )
}
