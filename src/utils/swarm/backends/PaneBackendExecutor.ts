import { randomUUID } from 'node:crypto'
import { getSessionId } from '../../../bootstrap/state.js'
import {
  assertWorkerPolicyIdentity,
  type WorkerPolicyIdentity,
} from '../../../services/policy/index.js'
import type { WorkerReport } from '../../../tools/AgentTool/workerReport.js'
import type { ToolUseContext } from '../../../Tool.js'
import type { TaskState } from '../../../tasks/types.js'
import { formatAgentId, parseAgentId } from '../../../utils/agentId.js'
import { quote } from '../../../utils/bash/shellQuote.js'
import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { jsonStringify } from '../../../utils/slowOperations.js'
import {
  createIdleNotification,
  isWorkerReportFreshAndCorrelated,
  readLatestWorkerReportEnvelope,
  resolveWorkerReportTerminalStatus,
  writeToMailbox,
} from '../../../utils/teammateMailbox.js'
import { readTeamFile } from '../teamHelpers.js'
import {
  acquireSwarmWorkerSlot,
  releaseSwarmWorkerSlot,
} from '../concurrencyPolicy.js'
import {
  buildInheritedCliFlags,
  buildInheritedEnvVars,
  getTeammateCommand,
} from '../spawnUtils.js'
import { assignTeammateColor } from '../teammateLayoutManager.js'
import {
  getPaneTeammateTerminalPatch,
  type PaneTaskTerminalTarget,
  type PaneTeammateTerminalStatus,
} from '../lifecyclePolicy.js'
import { TEAM_LEAD_NAME } from '../constants.js'
import {
  buildWorkerTeamReport,
  serializeWorkerTeamReportMessage,
} from '../workerTeamReport.js'
import { isInsideTmux } from './detection.js'
import {
  resolveWorkerRuntime,
  type WorkerEffort,
  type WorkerEffortInput,
} from './types.js'
import type {
  BackendType,
  PaneBackend,
  TeammateExecutor,
  TeammateMessage,
  TeammateSpawnConfig,
  TeammateSpawnResult,
} from './types.js'

const WORKER_LIFECYCLE_RUN_ID_ENV = 'MINDCODE_WORKER_RUN_ID'

function createWorkerLifecycleRunId(): string {
  return `worker-lifecycle:${randomUUID()}`
}

/**
 * PaneBackendExecutor adapts a PaneBackend to the TeammateExecutor interface.
 *
 * This allows pane-based backends (tmux, iTerm2) to be used through the same
 * TeammateExecutor abstraction as InProcessBackend, making getTeammateExecutor()
 * return a meaningful executor regardless of execution mode.
 *
 * The adapter handles:
 * - spawn(): Creates a pane and sends the Claude CLI command to it
 * - sendMessage(): Writes to the teammate's file-based mailbox
 * - terminate(): Sends a shutdown request via mailbox
 * - kill(): Kills the pane via the backend
 * - isActive(): Checks if the pane is still running
 */
export type ExistingPaneTrackingConfig = {
  agentId: string
  paneId: string
  insideTmux: boolean
  teamName: string
  concurrencyLeaseId: string
  effort?: WorkerEffortInput
  taskId?: string
  workerRunId?: string
  policyEpoch?: number
  policyDigest?: string
  lifecycleStartedAtMs?: number
}

/**
 * Pane exit is successful only when the worker's latest mailbox report is a
 * schema-valid, completion-eligible WorkerReport. Explicit kills never become
 * successful completions.
 */
export function resolvePaneTeammateTerminalStatus(
  report: WorkerReport | null | undefined,
  requestedStatus: 'completed' | 'killed' = 'completed',
  expectedPolicy?: WorkerPolicyIdentity,
): PaneTeammateTerminalStatus {
  if (requestedStatus === 'killed') return 'killed'
  return resolveWorkerReportTerminalStatus(report, expectedPolicy)
}

function resolvePanePolicyIdentity(
  policyEpoch: number | undefined,
  policyDigest: string | undefined,
): WorkerPolicyIdentity {
  if (policyEpoch === undefined && policyDigest === undefined) {
    throw new Error(
      'Pane Worker policy epoch and source digest are required at the production boundary',
    )
  }
  return assertWorkerPolicyIdentity({ policyEpoch, policyDigest }, 'Pane Worker')
}

export class PaneBackendExecutor implements TeammateExecutor {
  readonly type: BackendType

  private backend: PaneBackend
  private context: ToolUseContext | null = null

  /**
   * Track spawned teammates by agentId -> paneId mapping.
   * This allows us to find the pane for operations like kill/terminate.
   */
  private spawnedTeammates: Map<
    string,
    {
      paneId: string
      insideTmux: boolean
      concurrencyLeaseId: string
      teamName: string
      seenInTeamFile: boolean
      workerEffort: WorkerEffort
      taskId: string
      workerRunId?: string
      policyEpoch: number
      policyDigest: string
      lifecycleStartedAtMs: number
    }
  >
  private cleanupRegistered = false
  private lifecycleWatchers = new Map<
    string,
    ReturnType<typeof setInterval>
  >()
  private readonly lifecyclePollIntervalMs = 1000

  constructor(backend: PaneBackend) {
    this.backend = backend
    this.type = backend.type
    this.spawnedTeammates = new Map()
  }

  /**
   * Sets the ToolUseContext for this executor.
   * Must be called before spawn() to provide access to AppState and permissions.
   */
  setContext(context: ToolUseContext): void {
    this.context = context
  }

  /**
   * Checks if the underlying pane backend is available.
   */
  async isAvailable(): Promise<boolean> {
    return this.backend.isAvailable()
  }

  /**
   * Spawns a teammate in a new pane.
   *
   * Creates a pane via the backend, builds the CLI command with teammate
   * identity flags, and sends it to the pane.
   */
  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    const agentId = formatAgentId(config.name, config.teamName)

    if (!this.context) {
      logForDebugging(
        `[PaneBackendExecutor] spawn() called without context for ${config.name}`,
      )
      return {
        success: false,
        agentId,
        error:
          'PaneBackendExecutor not initialized. Call setContext() before spawn().',
      }
    }

    const { model: workerModel, effort: workerEffort } = resolveWorkerRuntime(
      config.effort,
    )
    const workerPolicy = resolvePanePolicyIdentity(
      config.policyEpoch,
      config.policyDigest,
    )
    const workerLease = await acquireSwarmWorkerSlot(config.teamName, {
      effort: workerEffort,
      signal: config.abortSignal,
    })
    const lifecycleStartedAtMs = Date.now()
    const workerRunId = createWorkerLifecycleRunId()
    let createdPaneId: string | undefined
    let createdPaneUsesExternalSession = false

    try {
      // Assign a unique color to this teammate
      const teammateColor = config.color ?? assignTeammateColor(agentId)

      // Create a pane in the swarm view
      const { paneId, isFirstTeammate } =
        await this.backend.createTeammatePaneInSwarmView(
          config.name,
          teammateColor,
        )
      createdPaneId = paneId

      // Check if we're inside tmux to determine how to send commands
      const insideTmux = await isInsideTmux()
      createdPaneUsesExternalSession = !insideTmux

      // Enable pane border status on first teammate when inside tmux
      if (isFirstTeammate && insideTmux) {
        await this.backend.enablePaneBorderStatus()
      }

      // Build the command to spawn MindCode with teammate identity
      const binaryPath = getTeammateCommand()

      // Build teammate identity CLI args
      const teammateArgs = [
        `--agent-id ${quote([agentId])}`,
        `--agent-name ${quote([config.name])}`,
        `--team-name ${quote([config.teamName])}`,
        `--agent-color ${quote([teammateColor])}`,
        `--parent-session-id ${quote([config.parentSessionId || getSessionId()])}`,
        config.planModeRequired ? '--plan-mode-required' : '',
        config.agentType ? `--agent-type ${quote([config.agentType])}` : '',
      ]
        .filter(Boolean)
        .join(' ')

      // Build CLI flags to propagate to teammate
      const appState = this.context.getAppState()
      let inheritedFlags = buildInheritedCliFlags({
        planModeRequired: config.planModeRequired,
        permissionMode: appState.toolPermissionContext.mode,
      })

      // Every pane worker is pinned to the canonical VEXZY Worker runtime.
      inheritedFlags = inheritedFlags
        .split(' ')
        .filter(
          (flag, i, arr) => flag !== '--model' && arr[i - 1] !== '--model',
        )
        .join(' ')
      inheritedFlags = inheritedFlags
        ? `${inheritedFlags} --model ${quote([workerModel])}`
        : `--model ${quote([workerModel])}`
      inheritedFlags = `${inheritedFlags} --effort ${quote([workerEffort])}`

      const flagsStr = inheritedFlags ? ` ${inheritedFlags}` : ''
      const workingDir = config.cwd

      // Build environment variables to forward to teammate
      const envStr = [
        buildInheritedEnvVars(undefined, workerPolicy),
        `${WORKER_LIFECYCLE_RUN_ID_ENV}=${quote([workerRunId])}`,
      ]
        .filter(Boolean)
        .join(' ')

      const spawnCommand = `cd ${quote([workingDir])} && env ${envStr} exec ${quote([binaryPath])} ${teammateArgs}${flagsStr}`

      // Send the command to the new pane
      // Use swarm socket when running outside tmux (external swarm session)
      await this.backend.sendCommandToPane(paneId, spawnCommand, !insideTmux)

      this.trackExistingPane({
        agentId,
        paneId,
        insideTmux,
        teamName: config.teamName,
        concurrencyLeaseId: workerLease.leaseId,
        effort: workerEffort,
        taskId: agentId,
        workerRunId,
        policyEpoch: workerPolicy.policyEpoch,
        policyDigest: workerPolicy.policyDigest,
        lifecycleStartedAtMs,
      })

      // Send initial instructions to teammate via mailbox
      await writeToMailbox(
        config.name,
        {
          from: 'team-lead',
          text: config.prompt,
          timestamp: new Date().toISOString(),
        },
        config.teamName,
      )

      logForDebugging(
        `[PaneBackendExecutor] Spawned teammate ${agentId} in pane ${paneId}`,
      )

      return {
        success: true,
        agentId,
        paneId,
      }
    } catch (error) {
      void this.releaseTrackedTeammate(agentId, 'killed')
      if (createdPaneId) {
        try {
          await this.backend.killPane(
            createdPaneId,
            createdPaneUsesExternalSession,
          )
        } catch (cleanupError) {
          logForDebugging(
            `[PaneBackendExecutor] Failed to clean up pane ${createdPaneId}: ${cleanupError}`,
          )
        }
      }
      workerLease.release()
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      logForDebugging(
        `[PaneBackendExecutor] Failed to spawn ${agentId}: ${errorMessage}`,
      )
      return {
        success: false,
        agentId,
        error: errorMessage,
      }
    }
  }

  /**
   * Registers a pane created by a legacy/direct spawn path with the same
   * lifecycle watcher used by executor-owned panes.
   */
  trackExistingPane(config: ExistingPaneTrackingConfig): void {
    const { effort: workerEffort } = resolveWorkerRuntime(config.effort)
    const workerPolicy = resolvePanePolicyIdentity(
      config.policyEpoch,
      config.policyDigest,
    )
    this.spawnedTeammates.set(config.agentId, {
      paneId: config.paneId,
      insideTmux: config.insideTmux,
      concurrencyLeaseId: config.concurrencyLeaseId,
      teamName: config.teamName,
      seenInTeamFile: false,
      workerEffort,
      taskId: config.taskId ?? config.agentId,
      workerRunId: config.workerRunId,
      policyEpoch: workerPolicy.policyEpoch,
      policyDigest: workerPolicy.policyDigest,
      lifecycleStartedAtMs: config.lifecycleStartedAtMs ?? Date.now(),
    })
    this.startLifecycleWatcher(config.agentId)
    this.ensureCleanupRegistered()
  }

  /**
   * Sends a message to a pane-based teammate via file-based mailbox.
   *
   * All teammates (pane and in-process) use the same mailbox mechanism.
   */
  async sendMessage(agentId: string, message: TeammateMessage): Promise<void> {
    logForDebugging(
      `[PaneBackendExecutor] sendMessage() to ${agentId}: ${message.text.substring(0, 50)}...`,
    )

    const parsed = parseAgentId(agentId)
    if (!parsed) {
      throw new Error(
        `Invalid agentId format: ${agentId}. Expected format: agentName@teamName`,
      )
    }

    const { agentName, teamName } = parsed

    await writeToMailbox(
      agentName,
      {
        text: message.text,
        from: message.from,
        color: message.color,
        timestamp: message.timestamp ?? new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(
      `[PaneBackendExecutor] sendMessage() completed for ${agentId}`,
    )
  }

  /**
   * Gracefully terminates a pane-based teammate.
   *
   * For pane-based teammates, we send a shutdown request via mailbox and
   * let the teammate process handle exit gracefully.
   */
  async terminate(agentId: string, reason?: string): Promise<boolean> {
    logForDebugging(
      `[PaneBackendExecutor] terminate() called for ${agentId}: ${reason}`,
    )

    const parsed = parseAgentId(agentId)
    if (!parsed) {
      logForDebugging(
        '[PaneBackendExecutor] terminate() failed: invalid agentId format',
      )
      return false
    }

    const { agentName, teamName } = parsed

    // Send shutdown request via mailbox
    const shutdownRequest = {
      type: 'shutdown_request',
      requestId: `shutdown-${agentId}-${Date.now()}`,
      from: 'team-lead',
      reason,
    }

    await writeToMailbox(
      agentName,
      {
        from: 'team-lead',
        text: jsonStringify(shutdownRequest),
        timestamp: new Date().toISOString(),
      },
      teamName,
    )

    logForDebugging(
      `[PaneBackendExecutor] terminate() sent shutdown request to ${agentId}`,
    )

    return true
  }

  /**
   * Force kills a pane-based teammate by killing its pane.
   */
  async kill(agentId: string): Promise<boolean> {
    logForDebugging(`[PaneBackendExecutor] kill() called for ${agentId}`)

    const teammateInfo = this.spawnedTeammates.get(agentId)
    if (!teammateInfo) {
      logForDebugging(
        `[PaneBackendExecutor] kill() failed: teammate ${agentId} not found in spawned map`,
      )
      return false
    }

    const { paneId, insideTmux } = teammateInfo

    // Kill the pane via the backend
    // Use external session socket when we spawned outside tmux
    let killed = false
    try {
      killed = await this.backend.killPane(paneId, !insideTmux)
    } catch (error) {
      logForDebugging(
        `[PaneBackendExecutor] kill backend failed for ${agentId}: ${error}`,
      )
      await this.reconcileTeammateLifecycle(agentId)
      return false
    }

    if (killed) {
      await this.releaseTrackedTeammate(agentId, 'killed')
      logForDebugging(`[PaneBackendExecutor] kill() succeeded for ${agentId}`)
    } else {
      // A failed kill can mean the pane already exited between the lookup and
      // the kill command. Reconcile that state so an already-dead worker does
      // not retain its permit until the next polling interval.
      await this.reconcileTeammateLifecycle(agentId)
      logForDebugging(`[PaneBackendExecutor] kill() failed for ${agentId}`)
    }

    return killed
  }

  /**
   * Checks if a pane-based teammate is still active.
   *
   * For pane-based teammates, we check if the pane still exists.
   * This is a best-effort check - the pane may exist but the process inside
   * may have exited.
   */
  async isActive(agentId: string): Promise<boolean> {
    logForDebugging(`[PaneBackendExecutor] isActive() called for ${agentId}`)
    return this.reconcileTeammateLifecycle(agentId)
  }

  private ensureCleanupRegistered(): void {
    if (this.cleanupRegistered) return
    this.cleanupRegistered = true
    registerCleanup(async () => {
      for (const [id, info] of this.spawnedTeammates) {
        logForDebugging(
          `[PaneBackendExecutor] Cleanup: killing pane for ${id}`,
        )
        try {
          await this.backend.killPane(info.paneId, !info.insideTmux)
        } catch (error) {
          logForDebugging(
            `[PaneBackendExecutor] Cleanup failed for ${id}: ${error}`,
          )
        } finally {
          await this.releaseTrackedTeammate(id, 'killed')
        }
      }
      this.spawnedTeammates.clear()
    })
  }

  /**
   * Polls lifecycle state for pane workers. The teammate process is launched
   * with `exec`, so a missing pane is equivalent to process exit. The team
   * file is a secondary signal for graceful shutdown, where the leader removes
   * the member after receiving shutdown_approved.
   */
  private startLifecycleWatcher(agentId: string): void {
    if (this.lifecycleWatchers.has(agentId)) return

    const watcher = setInterval(() => {
      void this.reconcileTeammateLifecycle(agentId).catch(error => {
        logForDebugging(
          `[PaneBackendExecutor] Lifecycle watcher failed for ${agentId}: ${error}`,
        )
      })
    }, this.lifecyclePollIntervalMs)
    watcher.unref?.()
    this.lifecycleWatchers.set(agentId, watcher)
  }

  private captureTaskTerminalTargets(
    agentId: string,
  ): PaneTaskTerminalTarget[] {
    const appState = this.context?.getAppState()
    if (!appState) return []

    return Object.entries<TaskState>(appState.tasks).flatMap(
      ([taskKey, task]) => {
        if (
          task.type !== 'in_process_teammate' ||
          task.status !== 'running' ||
          task.identity?.agentId !== agentId
        ) {
          return []
        }
        return [
          {
            taskKey,
            taskId: task.id,
            startTime: task.startTime,
            agentId,
          },
        ]
      },
    )
  }

  private markTaskTerminal(
    targets: readonly PaneTaskTerminalTarget[],
    terminalStatus: PaneTeammateTerminalStatus,
  ): void {
    if (targets.length === 0) return
    this.context?.setAppState(prev => {
      let changed = false
      const tasks = Object.fromEntries(
        Object.entries<TaskState>(prev.tasks).map(([taskId, task]) => {
          const target = targets.find(candidate => candidate.taskKey === taskId)
          if (!target) return [taskId, task]
          const patch = getPaneTeammateTerminalPatch(
            task,
            target,
            terminalStatus,
          )
          if (!patch) return [taskId, task]
          changed = true
          return [taskId, { ...task, ...patch }]
        }),
      )
      return changed ? { ...prev, tasks } : prev
    })
  }

  private async reconcileTeammateLifecycle(agentId: string): Promise<boolean> {
    const teammateInfo = this.spawnedTeammates.get(agentId)
    if (!teammateInfo) return false

    if (this.backend.isPaneAlive) {
      let paneAlive: boolean
      try {
        paneAlive = await this.backend.isPaneAlive(
          teammateInfo.paneId,
          !teammateInfo.insideTmux,
        )
      } catch (error) {
        logForDebugging(
          `[PaneBackendExecutor] Pane liveness check failed for ${agentId}: ${error}`,
        )
        await this.releaseTrackedTeammate(agentId)
        return false
      }
      if (!paneAlive) {
        await this.releaseTrackedTeammate(agentId)
        return false
      }
    }

    const teamFile = readTeamFile(teammateInfo.teamName)
    if (teamFile) {
      const member = teamFile.members.find(m => m.agentId === agentId)
      if (member) {
        teammateInfo.seenInTeamFile = true
      } else if (teammateInfo.seenInTeamFile) {
        await this.releaseTrackedTeammate(agentId)
        return false
      }
    }

    return this.spawnedTeammates.has(agentId)
  }

  private async releaseTrackedTeammate(
    agentId: string,
    requestedStatus?: 'completed' | 'killed',
  ): Promise<boolean> {
    const teammateInfo = this.spawnedTeammates.get(agentId)
    if (!teammateInfo) return false

    // Capture exact AppState task keys and generations before any mailbox
    // await. A new worker may reuse the same agentId while this worker's
    // report is being finalized; its task must remain untouched.
    const terminalTargets = this.captureTaskTerminalTargets(agentId)

    const watcher = this.lifecycleWatchers.get(agentId)
    if (watcher) {
      clearInterval(watcher)
      this.lifecycleWatchers.delete(agentId)
    }

    this.spawnedTeammates.delete(agentId)

    let terminalStatus: PaneTeammateTerminalStatus =
      requestedStatus === 'killed' ? 'killed' : 'failed'
    try {
      const teamFile = readTeamFile(teammateInfo.teamName)
      const leaderName =
        teamFile?.members.find(member => member.agentId === teamFile.leadAgentId)
          ?.name ?? TEAM_LEAD_NAME
      const reportEnvelope =
        requestedStatus === 'killed'
          ? null
          : await readLatestWorkerReportEnvelope(
              leaderName,
              agentId,
              teammateInfo.teamName,
            )
      const report =
        reportEnvelope &&
        teammateInfo.workerRunId &&
        isWorkerReportFreshAndCorrelated(reportEnvelope, {
          workerId: agentId,
          taskId: teammateInfo.taskId,
          runId: teammateInfo.workerRunId,
          startedAtMs: teammateInfo.lifecycleStartedAtMs,
          policyEpoch: teammateInfo.policyEpoch,
          policyDigest: teammateInfo.policyDigest,
        })
          ? reportEnvelope.report
          : null
      if (!report && requestedStatus !== 'killed') {
        const failedReport = buildWorkerTeamReport({
          taskId: teammateInfo.taskId,
          runId: teammateInfo.workerRunId ?? createWorkerLifecycleRunId(),
          workerId: agentId,
          policyEpoch: teammateInfo.policyEpoch,
          policyDigest: teammateInfo.policyDigest,
          status: 'failed',
          effortUsed: teammateInfo.workerEffort,
          tokensUsed: 0,
          evidence: ['worker_report_missing'],
        })
        const notification = createIdleNotification(agentId, {
          idleReason: 'failed',
          report: failedReport,
        })
        await writeToMailbox(
          leaderName,
          {
            from: agentId,
            text: serializeWorkerTeamReportMessage(notification),
            timestamp: new Date().toISOString(),
          },
          teammateInfo.teamName,
        )
      }
      terminalStatus = resolvePaneTeammateTerminalStatus(
        report,
        requestedStatus ?? 'completed',
        {
          policyEpoch: teammateInfo.policyEpoch,
          policyDigest: teammateInfo.policyDigest,
        },
      )
    } catch (error) {
      logForDebugging(
        `[PaneBackendExecutor] Failed to finalize ${agentId}: ${error}`,
      )
    }

    // The map entry is removed before mailbox I/O, so every exit path must
    // release the lease and attempt task failure independently of reporting.
    try {
      releaseSwarmWorkerSlot(teammateInfo.concurrencyLeaseId)
    } catch (error) {
      logForDebugging(
        `[PaneBackendExecutor] Failed to release lease for ${agentId}: ${error}`,
      )
    }
    try {
      this.markTaskTerminal(terminalTargets, terminalStatus)
    } catch (error) {
      logForDebugging(
        `[PaneBackendExecutor] Failed to mark ${agentId} terminal: ${error}`,
      )
    }
    return true
  }
}

/**
 * Creates a PaneBackendExecutor wrapping the given PaneBackend.
 */
export function createPaneBackendExecutor(
  backend: PaneBackend,
): PaneBackendExecutor {
  return new PaneBackendExecutor(backend)
}
