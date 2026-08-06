import { DaemonRemoteError } from "../daemon/errors.js";

export const TASK_GRAPH_PROTOCOL_ERROR = "TASK_GRAPH_PROTOCOL_ERROR" as const;
export const TASK_GRAPH_REMOTE_ERROR = "TASK_GRAPH_REMOTE_ERROR" as const;

export type TaskGraphRemoteCode =
  | "TASK_NOT_FOUND"
  | "DUPLICATE_TASK"
  | "INVALID_TASK"
  | "DEPENDENCY_NOT_FOUND"
  | "DEPENDENCY_CYCLE"
  | "VERSION_CONFLICT"
  | "LEASE_CONFLICT"
  | "LEASE_OWNER_MISMATCH"
  | "INVALID_TRANSITION"
  | "DATABASE_CLOSED"
  | typeof TASK_GRAPH_PROTOCOL_ERROR
  | typeof TASK_GRAPH_REMOTE_ERROR;

export class TaskGraphDaemonError extends Error {
  readonly code: TaskGraphRemoteCode;
  readonly remoteCode?: string;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: TaskGraphRemoteCode,
    message: string,
    options: {
      remoteCode?: string;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "TaskGraphDaemonError";
    this.code = code;
    this.remoteCode = options.remoteCode;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class TaskGraphProtocolError extends TaskGraphDaemonError {
  constructor(message: string, cause?: unknown) {
    super(TASK_GRAPH_PROTOCOL_ERROR, message, { cause });
    this.name = "TaskGraphProtocolError";
  }
}

export class TaskGraphRemoteError extends TaskGraphDaemonError {
  constructor(
    message: string,
    remoteCode?: string,
    details?: unknown,
    cause?: unknown,
  ) {
    const stableCode = isStableRemoteCode(remoteCode)
      ? remoteCode
      : TASK_GRAPH_REMOTE_ERROR;
    super(stableCode, message, { remoteCode, details, cause });
    this.name = "TaskGraphRemoteError";
  }
}

export function normalizeTaskGraphError(error: unknown): unknown {
  if (error instanceof TaskGraphDaemonError) return error;
  if (error instanceof DaemonRemoteError) {
    return new TaskGraphRemoteError(
      error.message,
      error.remoteCode,
      error.details,
      error,
    );
  }
  return error;
}

function isStableRemoteCode(
  value: string | undefined,
): value is TaskGraphRemoteCode {
  return (
    value === "TASK_NOT_FOUND" ||
    value === "DUPLICATE_TASK" ||
    value === "INVALID_TASK" ||
    value === "DEPENDENCY_NOT_FOUND" ||
    value === "DEPENDENCY_CYCLE" ||
    value === "VERSION_CONFLICT" ||
    value === "LEASE_CONFLICT" ||
    value === "LEASE_OWNER_MISMATCH" ||
    value === "INVALID_TRANSITION" ||
    value === "DATABASE_CLOSED"
  );
}
