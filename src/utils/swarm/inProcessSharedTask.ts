import {
  assertWorkerPolicyIdentity,
  type WorkerPolicyIdentity,
} from '../../services/policy/index.js'
import {
  isWorkerReportCompletionEligibleForPolicy,
  type WorkerReport,
} from '../../tools/AgentTool/workerReport.js'
import {
  claimTask,
  getTask,
  type Task,
  updateTask,
} from '../tasks.js'

/** Claims an actual shared work task; AppState remains a UI mirror. */
export async function claimInProcessSharedTask(
  taskListId: string,
  taskId: string,
  owner: string,
  runId: string,
  policyIdentity: WorkerPolicyIdentity,
): Promise<Task> {
  const admittedPolicy = assertWorkerPolicyIdentity(policyIdentity)
  const admittedRunId = runId.trim()
  if (!admittedRunId) {
    throw new Error('In-process teammate graph run ID is required')
  }
  const claimed = await claimTask(taskListId, taskId, owner)
  if (!claimed.success || !claimed.task) {
    throw new Error(
      `In-process teammate graph task ${taskId} cannot be claimed: ${claimed.reason ?? 'unknown'}`,
    )
  }

  try {
    const running = await updateTask(taskListId, taskId, {
      status: 'in_progress',
      metadata: {
        worker_run_id: admittedRunId,
        policy_epoch: admittedPolicy.policyEpoch,
        policy_digest: admittedPolicy.policyDigest,
      },
    })
    if (
      !running ||
      (running.status !== 'running' && running.status !== 'in_progress') ||
      running.owner !== owner
    ) {
      throw new Error(
        `In-process teammate graph task ${taskId} did not enter running state`,
      )
    }
    return running
  } catch (error) {
    try {
      await updateTask(taskListId, taskId, {
        status: 'failed',
        metadata: { terminal_reason: 'running_transition_failed' },
      })
    } catch {
      // Preserve the transition error; lease recovery handles a temporary
      // authority outage.
    }
    throw error
  }
}

/**
 * Persists validated WorkerReport identity before terminalizing an actual
 * shared work task. An invalid report can only produce failed state.
 */
export async function settleInProcessSharedTask(
  taskListId: string,
  taskId: string,
  owner: string,
  runId: string,
  report: WorkerReport,
  policyIdentity: WorkerPolicyIdentity,
): Promise<boolean> {
  const admittedPolicy = assertWorkerPolicyIdentity(policyIdentity)
  const admittedRunId = runId.trim()
  if (!admittedRunId) {
    throw new Error('In-process teammate graph run ID is required')
  }
  const current = await getTask(taskListId, taskId)
  if (!current) {
    throw new Error(`In-process shared task ${taskId} was not found`)
  }

  const reportIsCorrelated =
    report.task_id === taskId &&
    report.worker_id === owner &&
    report.run_id === admittedRunId &&
    current.metadata?.worker_run_id === admittedRunId
  const reportIsValid =
    reportIsCorrelated &&
    isWorkerReportCompletionEligibleForPolicy(report, admittedPolicy)
  if (current.status === 'completed') {
    return reportIsValid && current.metadata?.report_id === report.report_id
  }
  if (current.status === 'failed') return false
  if (current.owner !== owner) {
    throw new Error(`In-process shared task ${taskId} is owned by another worker`)
  }
  if (
    current.status !== 'claimed' &&
    current.status !== 'running' &&
    current.status !== 'in_progress'
  ) {
    throw new Error(
      `In-process shared task ${taskId} is not claimable for terminal completion`,
    )
  }

  const terminalStatus = reportIsValid ? 'completed' : 'failed'
  const updated = await updateTask(taskListId, taskId, {
    status: terminalStatus,
    metadata: {
      report_id: report.report_id,
      policy_epoch: report.policy_epoch,
      policy_digest: report.policy_digest,
      worker_report_status: report.status,
    },
  })
  if (!updated || updated.status !== terminalStatus) {
    throw new Error(
      `In-process shared task ${taskId} failed to enter ${terminalStatus} state`,
    )
  }
  return reportIsValid
}
