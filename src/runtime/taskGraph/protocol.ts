import {
  type ClaimResult,
  type RecoveryResult,
  type RouteResult,
  type RouteTaskInput,
  TASK_EFFORTS,
  TASK_KINDS,
  TASK_STATUSES,
  type TaskEffort,
  type TaskGraphSnapshot,
  type TaskIsolation,
  type TaskKind,
  type TaskLease,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdate,
} from "../../tasks/graph/types.js";
import type { OverlapDecision } from "../../tasks/validation/overlap.js";
import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { TaskGraphProtocolError } from "./errors.js";

export type TaskGraphRequestOptions = DaemonRequestOptions;

export type TaskGraphDaemonTransport = {
  request?: <T>(
    method: string,
    params?: unknown,
    options?: DaemonRequestOptions,
  ) => Promise<T>;
  requestWithFallback?: <T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options?: DaemonRequestOptions,
  ) => Promise<DaemonCallResult<T>>;
};

export type TaskGraphListParams = {
  status?: TaskStatus | readonly TaskStatus[];
  owner?: string | null;
  limit?: number;
  offset?: number;
};

export type TaskGraphClaimParams = {
  task_id: string;
  owner: string;
  lease_id?: string;
  ttl_ms?: number;
  expected_version?: number;
  now?: string | Date;
};

export type TaskGraphUpdateParams = {
  task_id: string;
  patch: TaskUpdate;
  expected_version?: number;
};

export type TaskGraphLeaseParams = {
  lease_id: string;
  owner?: string;
  ttl_ms?: number;
  now?: string | Date;
};

export type TaskGraphReleaseParams = {
  lease_id: string;
  owner?: string;
  now?: string | Date;
};

export type TaskGraphWatchParams = {
  after_version?: number;
  poll_interval_ms?: number;
  idle_timeout_ms?: number;
};

export type TaskGraphWatchKind = "snapshot" | "changed" | "resync";

export type TaskGraphWatchChunk = {
  schema_version: 1;
  kind: TaskGraphWatchKind;
  graph_version: number;
  snapshot: TaskGraphSnapshot;
};

export type TaskGraphWatchEvent = TaskGraphWatchChunk & {
  sequence: number;
};

export type TaskGraphWatchResult = {
  reason: "idle_timeout";
  last_version: number;
};

export type TaskGraphRouteParams = {
  task: RouteTaskInput;
  mode?: "block" | "reject";
};

export type TaskGraphRouteUpdateParams = {
  task_id: string;
  patch: TaskUpdate;
  mode?: "block" | "reject";
  expected_version?: number;
};

export type TaskGraphResponse = {
  route: {
    task: TaskRecord | null;
    created: boolean;
    decision: OverlapDecision;
  };
  route_update: {
    task: TaskRecord | null;
    created: boolean;
    decision: OverlapDecision;
  };
  read: { task: TaskRecord | null };
  list: { tasks: TaskRecord[] };
  claim: ClaimResult;
  update: { task: TaskRecord };
  lease: { lease: TaskLease | null };
  recover: RecoveryResult;
  snapshot: TaskGraphSnapshot;
};

const TASK_KEYS = [
  "id",
  "status",
  "owner",
  "kind",
  "effort",
  "priority",
  "blocked_by",
  "claimed_at",
  "started_at",
  "finished_at",
  "files_touched",
  "read_set",
  "write_set",
  "isolation",
  "lease_id",
  "version",
  "policy_epoch",
  "report_id",
] as const;

const LEASE_KEYS = [
  "lease_id",
  "task_id",
  "owner",
  "acquired_at",
  "expires_at",
  "released_at",
] as const;

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskGraphProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  const object = record(value, context);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new TaskGraphProtocolError(`${context} contains an unknown field`);
    }
  }
  return object;
}

function required(
  object: Record<string, unknown>,
  key: string,
  context: string,
): unknown {
  if (!Object.prototype.hasOwnProperty.call(object, key)) {
    throw new TaskGraphProtocolError(`${context}.${key} is required`);
  }
  return object[key];
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string")
    throw new TaskGraphProtocolError(`${context} must be a string`);
  return value;
}

function nullableString(value: unknown, context: string): string | null {
  if (value !== null && typeof value !== "string") {
    throw new TaskGraphProtocolError(`${context} must be a string or null`);
  }
  return value as string | null;
}

function safeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value))
    throw new TaskGraphProtocolError(`${context} must be a safe integer`);
  return value as number;
}

function nonNegativeSafeInteger(value: unknown, context: string): number {
  const parsed = safeInteger(value, context);
  if (parsed < 0) {
    throw new TaskGraphProtocolError(
      `${context} must be a non-negative safe integer`,
    );
  }
  return parsed;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean")
    throw new TaskGraphProtocolError(`${context} must be a boolean`);
  return value;
}

function stringArray(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TaskGraphProtocolError(`${context} must be an array of strings`);
  }
  return [...(value as string[])];
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  context: string,
): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new TaskGraphProtocolError(`${context} has an invalid value`);
  }
  return value as T;
}

function nullableTask(value: unknown, context: string): TaskRecord | null {
  return value === null ? null : validateTaskRecord(value, context);
}

export function validateTaskRecord(
  value: unknown,
  context = "task",
): TaskRecord {
  const object = exact(value, TASK_KEYS, context);
  const task: TaskRecord = {
    id: stringValue(required(object, "id", context), `${context}.id`),
    status: enumValue(
      required(object, "status", context),
      TASK_STATUSES,
      `${context}.status`,
    ),
    owner: nullableString(
      required(object, "owner", context),
      `${context}.owner`,
    ),
    kind: enumValue(
      required(object, "kind", context),
      TASK_KINDS,
      `${context}.kind`,
    ),
    effort: enumValue(
      required(object, "effort", context),
      TASK_EFFORTS,
      `${context}.effort`,
    ),
    priority: safeInteger(
      required(object, "priority", context),
      `${context}.priority`,
    ),
    blocked_by: stringArray(
      required(object, "blocked_by", context),
      `${context}.blocked_by`,
    ),
    claimed_at: nullableString(
      required(object, "claimed_at", context),
      `${context}.claimed_at`,
    ),
    started_at: nullableString(
      required(object, "started_at", context),
      `${context}.started_at`,
    ),
    finished_at: nullableString(
      required(object, "finished_at", context),
      `${context}.finished_at`,
    ),
    files_touched: stringArray(
      required(object, "files_touched", context),
      `${context}.files_touched`,
    ),
    read_set: stringArray(
      required(object, "read_set", context),
      `${context}.read_set`,
    ),
    write_set: stringArray(
      required(object, "write_set", context),
      `${context}.write_set`,
    ),
    isolation: enumValue(
      required(object, "isolation", context),
      ["shared", "worktree"] as const,
      `${context}.isolation`,
    ),
    lease_id: nullableString(
      required(object, "lease_id", context),
      `${context}.lease_id`,
    ),
    version: safeInteger(
      required(object, "version", context),
      `${context}.version`,
    ),
    policy_epoch: safeInteger(
      required(object, "policy_epoch", context),
      `${context}.policy_epoch`,
    ),
    report_id: nullableString(
      required(object, "report_id", context),
      `${context}.report_id`,
    ),
  };
  return task;
}

export function validateTaskLease(
  value: unknown,
  context = "lease",
): TaskLease {
  const object = exact(value, LEASE_KEYS, context);
  return {
    lease_id: stringValue(
      required(object, "lease_id", context),
      `${context}.lease_id`,
    ),
    task_id: stringValue(
      required(object, "task_id", context),
      `${context}.task_id`,
    ),
    owner: stringValue(required(object, "owner", context), `${context}.owner`),
    acquired_at: stringValue(
      required(object, "acquired_at", context),
      `${context}.acquired_at`,
    ),
    expires_at: stringValue(
      required(object, "expires_at", context),
      `${context}.expires_at`,
    ),
    released_at: nullableString(
      required(object, "released_at", context),
      `${context}.released_at`,
    ),
  };
}

function validateConflict(
  value: unknown,
  context: string,
): OverlapDecision["conflicts"][number] {
  const object = exact(
    value,
    ["task_id", "paths", "kinds", "existing_isolation", "new_isolation"],
    context,
  );
  return {
    task_id: stringValue(
      required(object, "task_id", context),
      `${context}.task_id`,
    ),
    paths: stringArray(required(object, "paths", context), `${context}.paths`),
    kinds: stringArray(
      required(object, "kinds", context),
      `${context}.kinds`,
    ).map((kind) => {
      if (kind !== "write_write" && kind !== "write_read")
        throw new TaskGraphProtocolError(
          `${context}.kinds has an invalid value`,
        );
      return kind;
    }),
    existing_isolation: enumValue(
      required(object, "existing_isolation", context),
      ["shared", "worktree"] as const,
      `${context}.existing_isolation`,
    ),
    new_isolation: enumValue(
      required(object, "new_isolation", context),
      ["shared", "worktree"] as const,
      `${context}.new_isolation`,
    ),
  };
}

export function validateOverlapDecision(
  value: unknown,
  context = "decision",
): OverlapDecision {
  const object = exact(
    value,
    ["action", "allowed", "mode", "isolation", "conflicts", "blocked_by"],
    context,
  );
  const conflicts = required(object, "conflicts", context);
  if (!Array.isArray(conflicts))
    throw new TaskGraphProtocolError(`${context}.conflicts must be an array`);
  return {
    action: enumValue(
      required(object, "action", context),
      [
        "allow",
        "blocked",
        "worktree_isolated",
        "rejected",
        "idempotent",
      ] as const,
      `${context}.action`,
    ),
    allowed: booleanValue(
      required(object, "allowed", context),
      `${context}.allowed`,
    ),
    mode: enumValue(
      required(object, "mode", context),
      ["block", "reject"] as const,
      `${context}.mode`,
    ),
    isolation: enumValue(
      required(object, "isolation", context),
      ["shared", "worktree"] as const,
      `${context}.isolation`,
    ),
    conflicts: conflicts.map((item, index) =>
      validateConflict(item, `${context}.conflicts[${index}]`),
    ),
    blocked_by: stringArray(
      required(object, "blocked_by", context),
      `${context}.blocked_by`,
    ),
  };
}

export function validateRouteResult(value: unknown): RouteResult {
  const object = exact(value, ["task", "created", "decision"], "route result");
  return {
    task: nullableTask(
      required(object, "task", "route result"),
      "route result.task",
    ),
    created: booleanValue(
      required(object, "created", "route result"),
      "route result.created",
    ),
    decision: validateOverlapDecision(
      required(object, "decision", "route result"),
    ),
  };
}

export function validateReadResult(value: unknown): {
  task: TaskRecord | null;
} {
  const object = exact(value, ["task"], "read result");
  return {
    task: nullableTask(
      required(object, "task", "read result"),
      "read result.task",
    ),
  };
}

export function validateListResult(value: unknown): { tasks: TaskRecord[] } {
  const object = exact(value, ["tasks"], "list result");
  const tasks = required(object, "tasks", "list result");
  if (!Array.isArray(tasks))
    throw new TaskGraphProtocolError("list result.tasks must be an array");
  return {
    tasks: tasks.map((task, index) =>
      validateTaskRecord(task, `list result.tasks[${index}]`),
    ),
  };
}

export const validateListDependentsResult = validateListResult;

export function validateClaimResult(value: unknown): ClaimResult {
  const object = record(value, "claim result");
  const ok = booleanValue(
    required(object, "ok", "claim result"),
    "claim result.ok",
  );
  if (ok) {
    const exactObject = exact(value, ["ok", "task", "lease"], "claim success");
    return {
      ok: true,
      task: validateTaskRecord(
        required(exactObject, "task", "claim success"),
        "claim success.task",
      ),
      lease: validateTaskLease(
        required(exactObject, "lease", "claim success"),
        "claim success.lease",
      ),
    };
  }
  const exactObject = exact(
    value,
    [
      "ok",
      "reason",
      "task",
      "blocked_by",
      "expected_version",
      "actual_version",
    ],
    "claim failure",
  );
  const result: ClaimResult = {
    ok: false,
    reason: enumValue(
      required(exactObject, "reason", "claim failure"),
      [
        "not_found",
        "version_conflict",
        "status_not_pending",
        "dependencies_incomplete",
        "lease_active",
        "lease_conflict",
      ] as const,
      "claim failure.reason",
    ),
    task: nullableTask(
      required(exactObject, "task", "claim failure"),
      "claim failure.task",
    ),
    blocked_by: stringArray(
      required(exactObject, "blocked_by", "claim failure"),
      "claim failure.blocked_by",
    ),
  };
  for (const key of ["expected_version", "actual_version"] as const) {
    if (Object.prototype.hasOwnProperty.call(exactObject, key)) {
      (result as unknown as Record<string, unknown>)[key] = safeInteger(
        exactObject[key],
        `claim failure.${key}`,
      );
    }
  }
  return result;
}

export function validateUpdateResult(value: unknown): { task: TaskRecord } {
  const object = exact(value, ["task"], "update result");
  return {
    task: validateTaskRecord(
      required(object, "task", "update result"),
      "update result.task",
    ),
  };
}

export function validateLeaseResult(value: unknown): {
  lease: TaskLease | null;
} {
  const object = exact(value, ["lease"], "lease result");
  const lease = required(object, "lease", "lease result");
  return {
    lease:
      lease === null ? null : validateTaskLease(lease, "lease result.lease"),
  };
}

export function validateRecoveryResult(value: unknown): RecoveryResult {
  const object = exact(
    value,
    ["expired_leases", "recovered_tasks", "leases", "tasks"],
    "recovery result",
  );
  const leases = (key: "expired_leases" | "leases"): TaskLease[] => {
    const value = required(object, key, "recovery result");
    if (!Array.isArray(value))
      throw new TaskGraphProtocolError(
        `recovery result.${key} must be an array`,
      );
    return value.map((item, index) =>
      validateTaskLease(item, `recovery result.${key}[${index}]`),
    );
  };
  const tasks = (key: "recovered_tasks" | "tasks"): TaskRecord[] => {
    const value = required(object, key, "recovery result");
    if (!Array.isArray(value))
      throw new TaskGraphProtocolError(
        `recovery result.${key} must be an array`,
      );
    return value.map((item, index) =>
      validateTaskRecord(item, `recovery result.${key}[${index}]`),
    );
  };
  return {
    expired_leases: leases("expired_leases"),
    recovered_tasks: tasks("recovered_tasks"),
    leases: leases("leases"),
    tasks: tasks("tasks"),
  };
}

export function validateSnapshot(value: unknown): TaskGraphSnapshot {
  const object = exact(
    value,
    ["version", "graph_version", "captured_at", "tasks"],
    "snapshot",
  );
  const tasks = required(object, "tasks", "snapshot");
  if (!Array.isArray(tasks))
    throw new TaskGraphProtocolError("snapshot.tasks must be an array");
  return {
    version: nonNegativeSafeInteger(
      required(object, "version", "snapshot"),
      "snapshot.version",
    ),
    graph_version: nonNegativeSafeInteger(
      required(object, "graph_version", "snapshot"),
      "snapshot.graph_version",
    ),
    captured_at: stringValue(
      required(object, "captured_at", "snapshot"),
      "snapshot.captured_at",
    ),
    tasks: tasks.map((task, index) =>
      validateTaskRecord(task, `snapshot.tasks[${index}]`),
    ),
  };
}

export function validateWatchChunk(value: unknown): TaskGraphWatchChunk {
  const object = exact(
    value,
    ["schema_version", "kind", "graph_version", "snapshot"],
    "watch chunk",
  );
  const schemaVersion = safeInteger(
    required(object, "schema_version", "watch chunk"),
    "watch chunk.schema_version",
  );
  if (schemaVersion !== 1) {
    throw new TaskGraphProtocolError(
      "watch chunk.schema_version is unsupported",
    );
  }
  const graphVersion = nonNegativeSafeInteger(
    required(object, "graph_version", "watch chunk"),
    "watch chunk.graph_version",
  );
  const snapshot = validateSnapshot(
    required(object, "snapshot", "watch chunk"),
  );
  if (graphVersion !== snapshot.graph_version) {
    throw new TaskGraphProtocolError(
      "watch chunk graph version does not match its snapshot",
    );
  }
  return {
    schema_version: 1,
    kind: enumValue(
      required(object, "kind", "watch chunk"),
      ["snapshot", "changed", "resync"] as const,
      "watch chunk.kind",
    ),
    graph_version: graphVersion,
    snapshot,
  };
}

export function validateWatchResult(value: unknown): TaskGraphWatchResult {
  const object = exact(value, ["reason", "last_version"], "watch result");
  return {
    reason: enumValue(
      required(object, "reason", "watch result"),
      ["idle_timeout"] as const,
      "watch result.reason",
    ),
    last_version: nonNegativeSafeInteger(
      required(object, "last_version", "watch result"),
      "watch result.last_version",
    ),
  };
}

export function serializeNow(
  value: string | Date | undefined,
): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()))
      throw new TypeError("now must be a valid date");
    return value.toISOString();
  }
  if (typeof value !== "string")
    throw new TypeError("now must be a string or Date");
  return value;
}

export function isTaskStatusValue(value: unknown): value is TaskStatus {
  return (
    typeof value === "string" &&
    (TASK_STATUSES as readonly string[]).includes(value)
  );
}

export type { TaskEffort, TaskIsolation, TaskKind };
