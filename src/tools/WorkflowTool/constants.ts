// Constants for the WorkflowTool (dynamic workflows / ultracode).
// Kept in a tiny leaf module because constants/tools.ts and
// utils/permissions/classifierDecision.ts import WORKFLOW_TOOL_NAME directly.

export const WORKFLOW_TOOL_NAME = 'Workflow'
export const RUN_WORKFLOW_ALIAS = 'RunWorkflow'

/** Built-in subagent type used to orchestrate the per-agent() work. */
export const WORKFLOW_SUBAGENT_TYPE = 'workflow-subagent'

/** Run-id prefix used by resumeFromRunId and worktree slugs (wf_<id>). */
export const WORKFLOW_RUN_ID_PREFIX = 'wf_'

/** Max bytes for a workflow script before it is rejected (256 KB). */
export const WORKFLOW_SCRIPT_MAX_BYTES = 256 * 1024

/** Synchronous execution budget for the VM script body (excludes awaits). */
export const WORKFLOW_SYNC_TIMEOUT_MS = 30_000

/** Hard cap on the number of agent() calls a single run may make. */
export const WORKFLOW_AGENT_CALL_CAP = 1000

/** Default fan-out concurrency for parallel()/pipeline(). */
export const WORKFLOW_DEFAULT_CONCURRENCY = 10

/** Max log lines retained for display. */
export const WORKFLOW_MAX_LOGS = 1000

/** Per-agent stall window (ms with no progress) before a retry. */
export const WORKFLOW_AGENT_STALL_MS = 180_000

/** Max stall retries per agent before giving up. */
export const WORKFLOW_AGENT_MAX_RETRIES = 3
