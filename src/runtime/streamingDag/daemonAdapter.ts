import { StreamingDagError } from "./errors.js";
import { DEFAULT_STREAMING_DAG_LIMITS } from "./types.js";
import type {
  StreamingDagLimits,
  StreamingDagSnapshot,
  StreamingDagTaskStatus,
} from "./types.js";

export const STREAMING_DAG_DAEMON_SCHEMA_VERSION = 1 as const;

export type DaemonTaskStatus =
  | "pending"
  | "claimed"
  | "running"
  | "completed"
  | "failed"
  | "blocked"
  | "cancelled";

export type DaemonTaskRecord<TPayload = unknown, TResult = unknown> = {
  id: string;
  status: DaemonTaskStatus;
  blocked_by: readonly string[];
  payload?: TPayload;
  result?: TResult;
  error?: unknown;
  [key: string]: unknown;
};

export type DaemonTaskGraphSnapshot<TPayload = unknown, TResult = unknown> = {
  version: number;
  graph_version: number;
  captured_at?: string;
  tasks: readonly DaemonTaskRecord<TPayload, TResult>[];
};

export type DaemonTaskGraphWatchChunk<TPayload = unknown, TResult = unknown> = {
  schema_version: typeof STREAMING_DAG_DAEMON_SCHEMA_VERSION;
  kind: "snapshot" | "changed" | "resync";
  graph_version: number;
  snapshot: DaemonTaskGraphSnapshot<TPayload, TResult>;
};

export type DaemonSnapshotAdapterOptions<TPayload, TTask> = {
  limits?: Partial<StreamingDagLimits>;
  payload?: (task: DaemonTaskRecord<TPayload>) => TTask;
};

/**
 * Converts the daemon's persistent TaskGraph shape into the in-memory
 * coordinator contract. The daemon's `blocked_by` list is the dependency
 * edge list; completed is the coordinator's succeeded state.
 */
export function normalizeDaemonSnapshot<TPayload = unknown, TTask = unknown>(
  source: DaemonTaskGraphSnapshot<TPayload>,
  options: DaemonSnapshotAdapterOptions<TPayload, TTask> = {},
): StreamingDagSnapshot<TTask, unknown> {
  validateDaemonSnapshot(source, options.limits);
  const payload =
    options.payload ?? ((task: DaemonTaskRecord<TPayload>) => task as TTask);
  return {
    sequence: source.version,
    graphVersion: source.graph_version,
    tasks: source.tasks.map((task) => ({
      id: task.id,
      dependencies: [...task.blocked_by],
      payload: payload(task),
      status: daemonStatusToCoordinatorStatus(task.status),
      ...(task.result !== undefined ? { result: task.result } : {}),
      ...(task.error !== undefined ? { error: task.error } : {}),
    })),
  };
}

export function normalizeDaemonWatchChunk<TPayload = unknown, TTask = unknown>(
  source: DaemonTaskGraphWatchChunk<TPayload>,
  options: DaemonSnapshotAdapterOptions<TPayload, TTask> = {},
): {
  kind: DaemonTaskGraphWatchChunk["kind"];
  graphVersion: number;
  snapshot: StreamingDagSnapshot<TTask, unknown>;
} {
  validateDaemonWatchChunk(source, options.limits);
  return {
    kind: source.kind,
    graphVersion: source.graph_version,
    snapshot: normalizeDaemonSnapshot(source.snapshot, options),
  };
}

export function daemonStatusToCoordinatorStatus(
  status: DaemonTaskStatus,
): StreamingDagTaskStatus {
  switch (status) {
    case "completed":
      return "succeeded";
    case "claimed":
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
  }
}

function validateDaemonSnapshot(
  source: DaemonTaskGraphSnapshot<unknown>,
  limits: Partial<StreamingDagLimits> = DEFAULT_STREAMING_DAG_LIMITS,
): void {
  if (!isObject(source)) invalidDaemonSnapshot("snapshot");
  if (!isSafeNonNegativeInteger(source.version)) {
    invalidDaemonSnapshot("version");
  }
  if (!isSafeNonNegativeInteger(source.graph_version)) {
    invalidDaemonSnapshot("graph_version");
  }
  if (!Array.isArray(source.tasks)) invalidDaemonSnapshot("tasks");
  if (
    source.tasks.length >
    (limits.maxTasks ?? DEFAULT_STREAMING_DAG_LIMITS.maxTasks)
  ) {
    invalidDaemonSnapshot("task count exceeds the configured limit");
  }
  const ids = new Set<string>();
  let totalDependencies = 0;
  for (const task of source.tasks) {
    if (!isObject(task)) invalidDaemonSnapshot("task");
    if (typeof task.id !== "string" || task.id.length === 0) {
      invalidDaemonSnapshot("task.id");
    }
    if (
      task.id.length >
      (limits.maxTaskIdLength ?? DEFAULT_STREAMING_DAG_LIMITS.maxTaskIdLength)
    ) {
      invalidDaemonSnapshot("task.id exceeds the configured length limit");
    }
    if (ids.has(task.id)) invalidDaemonSnapshot("duplicate task id");
    ids.add(task.id);
    if (!DAEMON_STATUSES.includes(task.status)) {
      invalidDaemonSnapshot("task.status");
    }
    if (
      !Array.isArray(task.blocked_by) ||
      task.blocked_by.some(
        (dependency) =>
          typeof dependency !== "string" || dependency.length === 0,
      )
    ) {
      invalidDaemonSnapshot("task.blocked_by");
    }
    if (
      task.blocked_by.length >
      (limits.maxDependenciesPerTask ??
        DEFAULT_STREAMING_DAG_LIMITS.maxDependenciesPerTask)
    ) {
      invalidDaemonSnapshot("task.blocked_by exceeds the configured limit");
    }
    totalDependencies += task.blocked_by.length;
  }
  if (
    totalDependencies >
    (limits.maxTotalDependencies ??
      DEFAULT_STREAMING_DAG_LIMITS.maxTotalDependencies)
  ) {
    invalidDaemonSnapshot("total dependencies exceed the configured limit");
  }
  for (const task of source.tasks) {
    for (const dependency of task.blocked_by) {
      if (!ids.has(dependency)) invalidDaemonSnapshot("missing dependency");
    }
  }
}

function validateDaemonWatchChunk(
  source: DaemonTaskGraphWatchChunk<unknown>,
  limits?: Partial<StreamingDagLimits>,
): void {
  if (!isObject(source)) invalidDaemonSnapshot("watch chunk");
  if (source.schema_version !== STREAMING_DAG_DAEMON_SCHEMA_VERSION) {
    invalidDaemonSnapshot("schema_version");
  }
  if (!WATCH_KINDS.includes(source.kind)) invalidDaemonSnapshot("kind");
  if (!isSafeNonNegativeInteger(source.graph_version)) {
    invalidDaemonSnapshot("graph_version");
  }
  validateDaemonSnapshot(source.snapshot, limits);
  if (source.snapshot.graph_version !== source.graph_version) {
    invalidDaemonSnapshot("graph_version mismatch");
  }
}

const DAEMON_STATUSES: readonly DaemonTaskStatus[] = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
  "blocked",
  "cancelled",
];

const WATCH_KINDS = ["snapshot", "changed", "resync"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function invalidDaemonSnapshot(field: string): never {
  throw new StreamingDagError(
    "INVALID_SNAPSHOT",
    `Invalid daemon task graph snapshot field: ${field}`,
  );
}
