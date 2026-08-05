export type TaskGraphErrorCode =
  | "TASK_NOT_FOUND"
  | "DUPLICATE_TASK"
  | "INVALID_TASK"
  | "DEPENDENCY_NOT_FOUND"
  | "DEPENDENCY_CYCLE"
  | "VERSION_CONFLICT"
  | "LEASE_CONFLICT"
  | "LEASE_OWNER_MISMATCH"
  | "INVALID_TRANSITION"
  | "DATABASE_CLOSED";

export class TaskGraphError extends Error {
  readonly code: TaskGraphErrorCode;

  constructor(code: TaskGraphErrorCode, message: string) {
    super(message);
    this.name = "TaskGraphError";
    this.code = code;
  }
}

export class TaskNotFoundError extends TaskGraphError {
  readonly taskId: string;

  constructor(taskId: string) {
    super("TASK_NOT_FOUND", `Task does not exist: ${taskId}`);
    this.name = "TaskNotFoundError";
    this.taskId = taskId;
  }
}

export class DuplicateTaskError extends TaskGraphError {
  readonly taskId: string;

  constructor(taskId: string) {
    super("DUPLICATE_TASK", `Task already exists: ${taskId}`);
    this.name = "DuplicateTaskError";
    this.taskId = taskId;
  }
}

export class InvalidTaskError extends TaskGraphError {
  constructor(message: string) {
    super("INVALID_TASK", message);
    this.name = "InvalidTaskError";
  }
}

export class DependencyNotFoundError extends TaskGraphError {
  readonly taskId: string;
  readonly dependencyId: string;

  constructor(taskId: string, dependencyId: string) {
    super(
      "DEPENDENCY_NOT_FOUND",
      `Task ${taskId} references missing dependency ${dependencyId}`,
    );
    this.name = "DependencyNotFoundError";
    this.taskId = taskId;
    this.dependencyId = dependencyId;
  }
}

export class DependencyCycleError extends TaskGraphError {
  readonly cycle: string[];

  constructor(cycle: readonly string[]) {
    super(
      "DEPENDENCY_CYCLE",
      `Dependency cycle rejected: ${cycle.join(" -> ")}`,
    );
    this.name = "DependencyCycleError";
    this.cycle = [...cycle];
  }
}

export class VersionConflictError extends TaskGraphError {
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;

  constructor(taskId: string, expectedVersion: number, actualVersion: number) {
    super(
      "VERSION_CONFLICT",
      `Version conflict for ${taskId}: expected ${expectedVersion}, actual ${actualVersion}`,
    );
    this.name = "VersionConflictError";
    this.taskId = taskId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class LeaseConflictError extends TaskGraphError {
  readonly leaseId: string;

  constructor(
    leaseId: string,
    message = `Lease is already in use: ${leaseId}`,
  ) {
    super("LEASE_CONFLICT", message);
    this.name = "LeaseConflictError";
    this.leaseId = leaseId;
  }
}

export class LeaseOwnerMismatchError extends TaskGraphError {
  readonly leaseId: string;

  constructor(leaseId: string) {
    super("LEASE_OWNER_MISMATCH", `Lease owner mismatch: ${leaseId}`);
    this.name = "LeaseOwnerMismatchError";
    this.leaseId = leaseId;
  }
}

export class InvalidTransitionError extends TaskGraphError {
  constructor(from: string, to: string) {
    super("INVALID_TRANSITION", `Invalid task transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class DatabaseClosedError extends TaskGraphError {
  constructor() {
    super("DATABASE_CLOSED", "Task graph database is closed");
    this.name = "DatabaseClosedError";
  }
}
