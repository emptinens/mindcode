export const TASK_STATUSES = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export type TaskIsolation = "shared" | "worktree";

export const TASK_KINDS = [
  "research",
  "implement",
  "verify",
  "integrate",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export const TASK_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type TaskEffort = (typeof TASK_EFFORTS)[number];

export interface TaskRecord {
  id: string;
  status: TaskStatus;
  owner: string | null;
  kind: TaskKind;
  effort: TaskEffort;
  priority: number;
  blocked_by: string[];
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  files_touched: string[];
  read_set: string[];
  write_set: string[];
  isolation: TaskIsolation;
  lease_id: string | null;
  version: number;
  policy_epoch: number;
  report_id: string | null;
}

export interface CreateTaskInput {
  id?: string;
  status?: TaskStatus;
  owner?: string | null;
  kind?: TaskKind;
  effort?: TaskEffort;
  priority?: number;
  blocked_by?: readonly string[];
  depends_on?: readonly string[];
  claimed_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  files_touched?: readonly string[];
  read_set?: readonly string[];
  write_set?: readonly string[];
  isolation?: TaskIsolation;
  lease_id?: string | null;
  policy_epoch?: number;
  report_id?: string | null;
  idempotency_key?: string;
  idempotencyKey?: string;
}

export interface TaskUpdate {
  status?: TaskStatus;
  owner?: string | null;
  kind?: TaskKind;
  effort?: TaskEffort;
  priority?: number;
  blocked_by?: readonly string[];
  depends_on?: readonly string[];
  claimed_at?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  files_touched?: readonly string[];
  read_set?: readonly string[];
  write_set?: readonly string[];
  isolation?: TaskIsolation;
  lease_id?: string | null;
  policy_epoch?: number;
  report_id?: string | null;
  version?: number;
  expected_version?: number;
  expectedVersion?: number;
}

export interface UpdateOptions {
  expected_version?: number;
  expectedVersion?: number;
}

export interface ListTasksOptions {
  status?: TaskStatus | readonly TaskStatus[];
  owner?: string | null;
  lease_id?: string | null;
  limit?: number;
  offset?: number;
}

export interface TaskLease {
  lease_id: string;
  task_id: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
}

export interface ClaimOptions {
  lease_id?: string;
  leaseId?: string;
  ttl_ms?: number;
  ttlMs?: number;
  expected_version?: number;
  expectedVersion?: number;
  now?: string | Date;
}

export interface ClaimRequest extends ClaimOptions {
  owner: string;
}

export type ClaimFailureReason =
  | "not_found"
  | "version_conflict"
  | "status_not_pending"
  | "dependencies_incomplete"
  | "lease_active"
  | "lease_conflict";

export interface ClaimSuccess {
  ok: true;
  task: TaskRecord;
  lease: TaskLease;
}

export interface ClaimFailure {
  ok: false;
  reason: ClaimFailureReason;
  task: TaskRecord | null;
  blocked_by: string[];
  expected_version?: number;
  actual_version?: number;
}

export type ClaimResult = ClaimSuccess | ClaimFailure;

export interface LeaseReleaseOptions {
  owner?: string;
  now?: string | Date;
}

export interface RecoveryResult {
  expired_leases: TaskLease[];
  recovered_tasks: TaskRecord[];
  leases: TaskLease[];
  tasks: TaskRecord[];
}

export interface TaskGraphSnapshot {
  version: number;
  graph_version: number;
  captured_at: string;
  tasks: readonly TaskRecord[];
}

export interface TaskGraphOptions {
  databasePath?: string;
  dbPath?: string;
  path?: string;
  configDir?: string;
  leaseTtlMs?: number;
  clock?: () => Date;
}

export interface RouteOptions {
  mode?: "block" | "reject";
  conflictMode?: "block" | "reject";
  expected_version?: number;
  expectedVersion?: number;
}

export interface RouteTaskInput extends CreateTaskInput {
  isolation?: TaskIsolation;
}

export interface RouteResult {
  task: TaskRecord | null;
  decision: import("../validation/overlap.js").OverlapDecision;
  created: boolean;
}
