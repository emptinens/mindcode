import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { ensureTaskGraphPaths } from "../../storage/taskGraphPaths.js";
import {
  type OverlapCandidate,
  type OverlapDecision,
  findOverlaps,
  makeOverlapDecision,
} from "../validation/overlap.js";
import { normalizeTargetSet, normalizeTargets } from "../validation/targets.js";
import {
  DatabaseClosedError,
  DependencyCycleError,
  DependencyNotFoundError,
  DuplicateTaskError,
  InvalidTaskError,
  LeaseConflictError,
  LeaseOwnerMismatchError,
  TaskGraphError,
  TaskNotFoundError,
  VersionConflictError,
} from "./errors.js";
import {
  type ClaimFailure,
  type ClaimOptions,
  type ClaimRequest,
  type ClaimResult,
  type ClaimSuccess,
  type CreateTaskInput,
  type LeaseReleaseOptions,
  type ListTasksOptions,
  type RecoveryResult,
  type RouteOptions,
  type RouteResult,
  type RouteTaskInput,
  TASK_EFFORTS,
  TASK_KINDS,
  TASK_STATUSES,
  type TaskEffort,
  type TaskGraphOptions,
  type TaskGraphSnapshot,
  type TaskIsolation,
  type TaskKind,
  type TaskLease,
  type TaskRecord,
  type TaskStatus,
  type TaskUpdate,
  type UpdateOptions,
} from "./types.js";

const DEFAULT_LEASE_TTL_MS = 30_000;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const TASK_GRAPH_SCHEMA_VERSION = 2;

const TASK_SELECT = `
  SELECT
    id,
    status,
    owner,
    kind,
    effort,
    priority,
    blocked_by,
    claimed_at,
    started_at,
    finished_at,
    files_touched,
    read_set,
    write_set,
    isolation,
    sets_explicit,
    lease_id,
    version,
    policy_epoch,
    report_id
  FROM tasks
`;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_graph_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO task_graph_meta(key, value)
  VALUES ('graph_version', '0');

  INSERT OR IGNORE INTO task_graph_meta(key, value)
  VALUES ('schema_version', '2');

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'running', 'completed', 'failed', 'blocked', 'cancelled')),
    owner TEXT,
    kind TEXT NOT NULL DEFAULT 'implement' CHECK (kind IN ('research', 'implement', 'verify', 'integrate')),
    effort TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')),
    priority INTEGER NOT NULL DEFAULT 0,
    blocked_by TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(blocked_by)),
    claimed_at TEXT,
    started_at TEXT,
    finished_at TEXT,
    files_touched TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(files_touched)),
    read_set TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(read_set)),
    write_set TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(write_set)),
    isolation TEXT NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared', 'worktree')),
    sets_explicit INTEGER NOT NULL DEFAULT 0 CHECK (sets_explicit IN (0, 1)),
    lease_id TEXT,
    version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
    policy_epoch INTEGER NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0),
    report_id TEXT
  );

  CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
  CREATE INDEX IF NOT EXISTS tasks_owner_idx ON tasks(owner);
  CREATE INDEX IF NOT EXISTS tasks_lease_idx ON tasks(lease_id);

  CREATE TABLE IF NOT EXISTS task_leases (
    lease_id TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    owner TEXT NOT NULL,
    acquired_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    released_at TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS task_leases_active_task_idx
    ON task_leases(task_id)
    WHERE released_at IS NULL;
  CREATE INDEX IF NOT EXISTS task_leases_expiry_idx
    ON task_leases(expires_at)
    WHERE released_at IS NULL;

  CREATE TABLE IF NOT EXISTS task_idempotency (
    idempotency_key TEXT PRIMARY KEY NOT NULL,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE
  );
`;

type TaskRow = {
  id: string;
  status: string;
  owner: string | null;
  kind: string;
  effort: string;
  priority: number;
  blocked_by: string;
  claimed_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  files_touched: string;
  read_set: string;
  write_set: string;
  isolation: string;
  sets_explicit: number;
  lease_id: string | null;
  version: number;
  policy_epoch: number;
  report_id: string | null;
};

type LeaseRow = {
  lease_id: string;
  task_id: string;
  owner: string;
  acquired_at: string;
  expires_at: string;
  released_at: string | null;
};

type IdempotencyRow = {
  task_id: string;
};

type GraphVersionRow = {
  value: string;
};

type DependencyRow = {
  id: string;
  blocked_by: string;
};

type DependencyStatusRow = {
  id: string;
  status: string;
};

type ExpectedVersionInput = number | UpdateOptions | undefined;

function hasOwn<T extends object>(value: T, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

function isTaskIsolation(value: string): value is TaskIsolation {
  return value === "shared" || value === "worktree";
}

function isTaskKind(value: string): value is TaskKind {
  return (TASK_KINDS as readonly string[]).includes(value);
}

function isTaskEffort(value: string): value is TaskEffort {
  return (TASK_EFFORTS as readonly string[]).includes(value);
}

function assertNonEmptyString(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new InvalidTaskError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function assertNullableString(
  value: string | null,
  field: string,
): string | null {
  if (value === null) {
    return null;
  }
  return assertNonEmptyString(value, field);
}

function assertNonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidTaskError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function assertSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new InvalidTaskError(`${field} must be a safe integer`);
  }
  return value;
}

function normalizeKind(value: TaskKind | undefined): TaskKind {
  const kind = value ?? "implement";
  if (!isTaskKind(kind)) {
    throw new InvalidTaskError(`Unknown task kind: ${String(kind)}`);
  }
  return kind;
}

function normalizeEffort(value: TaskEffort | undefined): TaskEffort {
  const effort = value ?? "medium";
  if (!isTaskEffort(effort)) {
    throw new InvalidTaskError(`Unknown task effort: ${String(effort)}`);
  }
  return effort;
}

function normalizePriority(value: number | undefined): number {
  return assertSafeInteger(value ?? 0, "priority");
}

function normalizeNullableText(
  value: string | null | undefined,
  field: string,
): string | null {
  if (value === undefined || value === null) return null;
  return assertNonEmptyString(value, field);
}

function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function normalizeStringArray(
  value: readonly string[] | undefined,
  field: string,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new InvalidTaskError(`${field} must be an array of strings`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new InvalidTaskError(
        `${field} must contain only non-empty strings`,
      );
    }
    const normalized = item.trim();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function parseStringArray(value: string, field: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored ${field} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string")
  ) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored ${field} is not a string array`,
    );
  }
  return [...new Set(parsed)] as string[];
}

function normalizeIdempotencyKey(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return assertNonEmptyString(value, "idempotency_key");
}

function normalizeNow(
  value: string | Date | undefined,
  clock: () => Date,
): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new InvalidTaskError("now must be a valid date");
    }
    return value.toISOString();
  }
  if (value !== undefined) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new InvalidTaskError("now must be a valid date");
    }
    return parsed.toISOString();
  }
  const current = clock();
  if (Number.isNaN(current.getTime())) {
    throw new InvalidTaskError("clock must return a valid date");
  }
  return current.toISOString();
}

function normalizeTtl(value: number | undefined, fallback: number): number {
  const ttl = value ?? fallback;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new InvalidTaskError("lease TTL must be a positive safe integer");
  }
  return ttl;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function rowToTask(row: TaskRow): TaskRecord {
  if (!isTaskStatus(row.status)) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored task has invalid status: ${row.status}`,
    );
  }
  if (!isTaskIsolation(row.isolation)) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored task has invalid isolation: ${row.isolation}`,
    );
  }
  if (!isTaskKind(row.kind)) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored task has invalid kind: ${row.kind}`,
    );
  }
  if (!isTaskEffort(row.effort)) {
    throw new TaskGraphError(
      "INVALID_TASK",
      `Stored task has invalid effort: ${row.effort}`,
    );
  }
  const task = {
    id: row.id,
    status: row.status,
    owner: row.owner,
    kind: row.kind,
    effort: row.effort,
    priority: row.priority,
    blocked_by: parseStringArray(row.blocked_by, "blocked_by"),
    claimed_at: row.claimed_at,
    started_at: row.started_at,
    finished_at: row.finished_at,
    files_touched: parseStringArray(row.files_touched, "files_touched"),
    read_set: parseStringArray(row.read_set, "read_set"),
    write_set: parseStringArray(row.write_set, "write_set"),
    isolation: row.isolation,
    lease_id: row.lease_id,
    version: row.version,
    policy_epoch: row.policy_epoch,
    report_id: row.report_id,
  };
  return task;
}

function rowToLease(row: LeaseRow): TaskLease {
  return {
    lease_id: row.lease_id,
    task_id: row.task_id,
    owner: row.owner,
    acquired_at: row.acquired_at,
    expires_at: row.expires_at,
    released_at: row.released_at,
  };
}

export class TaskGraph {
  readonly databasePath: string;

  private readonly db: Database;
  private readonly clock: () => Date;
  private readonly leaseTtlMs: number;
  private closed = false;

  static open(options: TaskGraphOptions = {}): TaskGraph {
    return new TaskGraph(options);
  }

  constructor(options: TaskGraphOptions = {}) {
    const configuredPath =
      options.databasePath ?? options.dbPath ?? options.path;
    const paths = ensureTaskGraphPaths(
      options.configDir
        ? { MINDCODE_CONFIG_DIR: options.configDir }
        : process.env,
    );
    const databasePath = configuredPath ?? paths.databasePath;

    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    this.databasePath = databasePath;
    this.clock = options.clock ?? (() => new Date());
    this.leaseTtlMs = normalizeTtl(options.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    this.db = new Database(databasePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};
    `);
    this.db.exec(SCHEMA);
    this.migrateTaskColumns();
  }

  private migrateTaskColumns(): void {
    const columns = this.db.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const addColumn = (name: string, definition: string): void => {
        if (!names.has(name)) {
          this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${definition}`);
          names.add(name);
        }
      };

      // Keep migrations additive. SQLite applies DEFAULT values to existing
      // rows, so reopening an older tasks.db never drops or rewrites the
      // existing task identity, lease, dependency, target, or version data.
      addColumn(
        "isolation",
        "TEXT NOT NULL DEFAULT 'shared' CHECK (isolation IN ('shared', 'worktree'))",
      );
      addColumn(
        "sets_explicit",
        "INTEGER NOT NULL DEFAULT 0 CHECK (sets_explicit IN (0, 1))",
      );
      addColumn(
        "kind",
        "TEXT NOT NULL DEFAULT 'implement' CHECK (kind IN ('research', 'implement', 'verify', 'integrate'))",
      );
      addColumn(
        "effort",
        "TEXT NOT NULL DEFAULT 'medium' CHECK (effort IN ('none', 'low', 'medium', 'high', 'xhigh', 'max'))",
      );
      addColumn("priority", "INTEGER NOT NULL DEFAULT 0");
      addColumn("started_at", "TEXT");
      addColumn("finished_at", "TEXT");
      addColumn("report_id", "TEXT");
      addColumn(
        "read_set",
        "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(read_set))",
      );
      addColumn(
        "write_set",
        "TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(write_set))",
      );
      addColumn(
        "policy_epoch",
        "INTEGER NOT NULL DEFAULT 0 CHECK (policy_epoch >= 0)",
      );

      // Older experimental builds accepted broader effort/kind values. Keep
      // those rows usable under the current contract while retaining every
      // other stored field unchanged.
      this.db
        .prepare(
          "UPDATE tasks SET effort = 'medium' WHERE effort IS NULL OR effort NOT IN ('none', 'low', 'medium', 'high', 'xhigh', 'max')",
        )
        .run();
      this.db
        .prepare(
          "UPDATE tasks SET kind = 'implement' WHERE kind IS NULL OR kind NOT IN ('research', 'implement', 'verify', 'integrate')",
        )
        .run();
      this.db
        .prepare("UPDATE tasks SET priority = 0 WHERE priority IS NULL")
        .run();
      this.db
        .prepare(
          "UPDATE task_graph_meta SET value = ? WHERE key = 'schema_version' AND CAST(value AS INTEGER) < ?",
        )
        .run(String(TASK_GRAPH_SCHEMA_VERSION), TASK_GRAPH_SCHEMA_VERSION);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    }
  }

  create(input: CreateTaskInput = {}, idempotencyKey?: string): TaskRecord {
    this.assertOpen();

    const id =
      input.id === undefined
        ? randomUUID()
        : assertNonEmptyString(input.id, "id");
    const status = input.status ?? "pending";
    if (!isTaskStatus(status)) {
      throw new InvalidTaskError(`Unknown task status: ${String(status)}`);
    }
    const owner =
      input.owner === undefined
        ? null
        : assertNullableString(input.owner, "owner");
    const kind = normalizeKind(input.kind);
    const effort = normalizeEffort(input.effort);
    const priority = normalizePriority(input.priority);
    const blockedBy = normalizeStringArray(
      input.blocked_by ?? input.depends_on,
      "blocked_by",
    );
    const claimedAt = normalizeNullableText(input.claimed_at, "claimed_at");
    const startedAtInput = normalizeNullableText(
      input.started_at,
      "started_at",
    );
    const finishedAtInput = normalizeNullableText(
      input.finished_at,
      "finished_at",
    );
    const lifecycleNow =
      startedAtInput === null &&
      finishedAtInput === null &&
      (status === "running" || isTerminalTaskStatus(status))
        ? normalizeNow(undefined, this.clock)
        : null;
    const startedAt =
      startedAtInput ?? (status === "running" ? lifecycleNow : null);
    const finishedAt =
      finishedAtInput ?? (isTerminalTaskStatus(status) ? lifecycleNow : null);
    const targetSet = normalizeTargetSet(
      input.files_touched,
      input.read_set,
      input.write_set,
    );
    const filesTouched = targetSet.files_touched;
    const readSet = targetSet.read_set;
    const writeSet = targetSet.write_set;
    const isolation = this.normalizeIsolation(input.isolation);
    const leaseId =
      input.lease_id === undefined
        ? null
        : assertNullableString(input.lease_id, "lease_id");
    const policyEpoch = assertNonNegativeInteger(
      input.policy_epoch ?? 0,
      "policy_epoch",
    );
    const reportId = normalizeNullableText(input.report_id, "report_id");
    const key = normalizeIdempotencyKey(
      idempotencyKey ?? input.idempotency_key ?? input.idempotencyKey,
    );

    if (
      (status === "claimed" || status === "running") &&
      (owner === null || leaseId === null)
    ) {
      throw new InvalidTaskError(
        "claimed and running tasks require owner and lease_id",
      );
    }

    return this.withWriteTransaction(() => {
      if (key !== undefined) {
        const existingByKey = this.db
          .prepare(
            "SELECT task_id FROM task_idempotency WHERE idempotency_key = ?",
          )
          .get(key) as IdempotencyRow | null | undefined;
        if (existingByKey != null) {
          const existing = this.readTaskInTransaction(existingByKey.task_id);
          if (existing === null) {
            throw new TaskGraphError(
              "INVALID_TASK",
              `Idempotency key points to missing task: ${key}`,
            );
          }
          return existing;
        }
      }

      if (this.readTaskInTransaction(id) !== null) {
        throw new DuplicateTaskError(id);
      }

      this.validateDependenciesInTransaction(id, blockedBy);

      try {
        this.db
          .prepare(`
            INSERT INTO tasks(
              id, status, owner, kind, effort, priority, blocked_by, claimed_at,
              started_at, finished_at,
              files_touched, read_set, write_set, isolation, sets_explicit,
              lease_id, version, policy_epoch, report_id
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
          `)
          .run(
            id,
            status,
            owner,
            kind,
            effort,
            priority,
            JSON.stringify(blockedBy),
            claimedAt,
            startedAt,
            finishedAt,
            JSON.stringify(filesTouched),
            JSON.stringify(readSet),
            JSON.stringify(writeSet),
            isolation,
            targetSet.explicit_sets ? 1 : 0,
            leaseId,
            policyEpoch,
            reportId,
          );
      } catch (error) {
        if (this.isConstraintError(error)) {
          throw new DuplicateTaskError(id);
        }
        throw error;
      }

      if (key !== undefined) {
        this.db
          .prepare(
            "INSERT INTO task_idempotency(idempotency_key, task_id) VALUES (?, ?)",
          )
          .run(key, id);
      }
      this.bumpGraphVersionInTransaction();
      return this.requireTaskInTransaction(id);
    });
  }

  createTask(input: CreateTaskInput = {}, idempotencyKey?: string): TaskRecord {
    return this.create(input, idempotencyKey);
  }

  /**
   * Atomically validate overlap, merge dependencies, and enqueue a task.
   * BEGIN IMMEDIATE makes the overlap read and INSERT one SQLite write
   * transaction, so concurrent routers cannot both observe a free target.
   */
  route(input: RouteTaskInput = {}, options: RouteOptions = {}): RouteResult {
    this.assertOpen();
    const id =
      input.id === undefined
        ? randomUUID()
        : assertNonEmptyString(input.id, "id");
    const status = input.status ?? "pending";
    if (!isTaskStatus(status)) {
      throw new InvalidTaskError(`Unknown task status: ${String(status)}`);
    }
    const owner =
      input.owner === undefined
        ? null
        : assertNullableString(input.owner, "owner");
    const kind = normalizeKind(input.kind);
    const effort = normalizeEffort(input.effort);
    const priority = normalizePriority(input.priority);
    const targetSet = normalizeTargetSet(
      input.files_touched,
      input.read_set,
      input.write_set,
    );
    const isolation = this.normalizeIsolation(input.isolation);
    const baseBlockedBy = normalizeStringArray(
      input.blocked_by ?? input.depends_on,
      "blocked_by",
    );
    const claimedAt = normalizeNullableText(input.claimed_at, "claimed_at");
    const startedAtInput = normalizeNullableText(
      input.started_at,
      "started_at",
    );
    const finishedAtInput = normalizeNullableText(
      input.finished_at,
      "finished_at",
    );
    const lifecycleNow =
      startedAtInput === null &&
      finishedAtInput === null &&
      (status === "running" || isTerminalTaskStatus(status))
        ? normalizeNow(undefined, this.clock)
        : null;
    const startedAt =
      startedAtInput ?? (status === "running" ? lifecycleNow : null);
    const finishedAt =
      finishedAtInput ?? (isTerminalTaskStatus(status) ? lifecycleNow : null);
    const leaseId =
      input.lease_id === undefined
        ? null
        : assertNullableString(input.lease_id, "lease_id");
    const policyEpoch = assertNonNegativeInteger(
      input.policy_epoch ?? 0,
      "policy_epoch",
    );
    const reportId = normalizeNullableText(input.report_id, "report_id");
    const key = normalizeIdempotencyKey(
      input.idempotency_key ?? input.idempotencyKey,
    );
    const mode = options.mode ?? options.conflictMode ?? "block";

    if (
      (status === "claimed" || status === "running") &&
      (owner === null || leaseId === null)
    ) {
      throw new InvalidTaskError(
        "claimed and running tasks require owner and lease_id",
      );
    }

    return this.withWriteTransaction(() => {
      if (key !== undefined) {
        const existingByKey = this.db
          .prepare(
            "SELECT task_id FROM task_idempotency WHERE idempotency_key = ?",
          )
          .get(key) as IdempotencyRow | null | undefined;
        if (existingByKey != null) {
          const existing = this.readTaskInTransaction(existingByKey.task_id);
          if (existing === null) {
            throw new TaskGraphError(
              "INVALID_TASK",
              `Idempotency key points to missing task: ${key}`,
            );
          }
          return {
            task: existing,
            created: false,
            decision: {
              action: "idempotent",
              allowed: true,
              mode,
              isolation: existing.isolation,
              conflicts: [],
              blocked_by: existing.blocked_by,
            } satisfies OverlapDecision,
          };
        }
      }
      if (this.readTaskInTransaction(id) !== null) {
        throw new DuplicateTaskError(id);
      }

      const candidate: OverlapCandidate = {
        id,
        files_touched: targetSet.files_touched,
        read_set: targetSet.read_set,
        write_set: targetSet.write_set,
        isolation,
        explicit_sets: targetSet.explicit_sets,
      };
      const conflicts =
        status === "completed" || status === "failed" || status === "cancelled"
          ? []
          : findOverlaps(candidate, this.readAllTasksInTransaction());
      const conflictIds = conflicts.map((conflict) => conflict.task_id);
      const mergedBlockedBy =
        isolation === "shared" && mode === "block"
          ? [...new Set([...baseBlockedBy, ...conflictIds])]
          : baseBlockedBy;
      const decision = makeOverlapDecision(
        isolation,
        conflicts,
        mergedBlockedBy,
        mode,
      );
      if (!decision.allowed) {
        return { task: null, created: false, decision };
      }

      this.validateDependenciesInTransaction(id, mergedBlockedBy);
      const blocked = decision.action === "blocked";
      const nextStatus = blocked ? "pending" : status;
      const nextOwner = blocked ? null : owner;
      const nextClaimedAt = blocked ? null : claimedAt;
      const nextLeaseId = blocked ? null : leaseId;
      this.insertTaskInTransaction({
        id,
        status: nextStatus,
        owner: nextOwner,
        kind,
        effort,
        priority,
        blockedBy: mergedBlockedBy,
        claimedAt: nextClaimedAt,
        startedAt: blocked ? null : startedAt,
        finishedAt: blocked ? null : finishedAt,
        filesTouched: targetSet.files_touched,
        readSet: targetSet.read_set,
        writeSet: targetSet.write_set,
        isolation,
        setsExplicit: targetSet.explicit_sets,
        leaseId: nextLeaseId,
        policyEpoch,
        reportId,
      });
      if (key !== undefined) {
        this.db
          .prepare(
            "INSERT INTO task_idempotency(idempotency_key, task_id) VALUES (?, ?)",
          )
          .run(key, id);
      }
      this.bumpGraphVersionInTransaction();
      return {
        task: this.requireTaskInTransaction(id),
        created: true,
        decision,
      };
    });
  }

  routeTask(
    input: RouteTaskInput = {},
    options: RouteOptions = {},
  ): RouteResult {
    return this.route(input, options);
  }

  validateAndRoute(
    input: RouteTaskInput = {},
    options: RouteOptions = {},
  ): RouteResult {
    return this.route(input, options);
  }

  /** Atomically revalidate an existing task after changing its target sets. */
  routeUpdate(
    taskId: string,
    patch: TaskUpdate,
    options: RouteOptions = {},
  ): RouteResult {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    const expectedVersion = this.extractExpectedVersion(options, patch);
    if (expectedVersion !== undefined) {
      assertNonNegativeInteger(expectedVersion, "expected_version");
    }
    const mode = options.mode ?? options.conflictMode ?? "block";

    return this.withWriteTransaction(() => {
      const current = this.readTaskInTransaction(id);
      if (current === null) throw new TaskNotFoundError(id);
      if (
        expectedVersion !== undefined &&
        current.version !== expectedVersion
      ) {
        throw new VersionConflictError(id, expectedVersion, current.version);
      }

      const nextFilesTouched = hasOwn(patch, "files_touched")
        ? normalizeTargets(patch.files_touched, "files_touched")
        : current.files_touched;
      const nextReadSet = hasOwn(patch, "read_set")
        ? normalizeTargets(patch.read_set, "read_set")
        : current.read_set;
      const nextWriteSet = hasOwn(patch, "write_set")
        ? normalizeTargets(patch.write_set, "write_set")
        : current.write_set;
      const nextIsolation = hasOwn(patch, "isolation")
        ? this.normalizeIsolation(patch.isolation)
        : current.isolation;
      const explicitSets =
        hasOwn(patch, "read_set") || hasOwn(patch, "write_set")
          ? true
          : this.hasExplicitSets(current);
      const baseBlockedBy =
        hasOwn(patch, "blocked_by") || hasOwn(patch, "depends_on")
          ? normalizeStringArray(
              (patch.blocked_by ?? patch.depends_on) as
                | readonly string[]
                | undefined,
              "blocked_by",
            )
          : current.blocked_by;
      const candidate: OverlapCandidate = {
        id,
        files_touched: nextFilesTouched,
        read_set: nextReadSet,
        write_set: nextWriteSet,
        isolation: nextIsolation,
        explicit_sets: explicitSets,
      };
      const conflicts =
        patch.status === "completed" ||
        patch.status === "failed" ||
        patch.status === "cancelled"
          ? []
          : findOverlaps(candidate, this.readAllTasksInTransaction());
      const mergedBlockedBy =
        nextIsolation === "shared" && mode === "block"
          ? [
              ...new Set([
                ...baseBlockedBy,
                ...conflicts.map((conflict) => conflict.task_id),
              ]),
            ]
          : baseBlockedBy;
      const decision = makeOverlapDecision(
        nextIsolation,
        conflicts,
        mergedBlockedBy,
        mode,
      );
      if (!decision.allowed) {
        return { task: current, created: false, decision };
      }
      this.validateDependenciesInTransaction(id, mergedBlockedBy);

      const nextKind = hasOwn(patch, "kind")
        ? normalizeKind(patch.kind)
        : current.kind;
      const nextEffort = hasOwn(patch, "effort")
        ? normalizeEffort(patch.effort)
        : current.effort;
      const nextPriority = hasOwn(patch, "priority")
        ? normalizePriority(patch.priority)
        : current.priority;
      let nextStartedAt = hasOwn(patch, "started_at")
        ? normalizeNullableText(patch.started_at, "started_at")
        : current.started_at;
      let nextFinishedAt = hasOwn(patch, "finished_at")
        ? normalizeNullableText(patch.finished_at, "finished_at")
        : current.finished_at;
      const nextReportId = hasOwn(patch, "report_id")
        ? normalizeNullableText(patch.report_id, "report_id")
        : current.report_id;

      let nextStatus = patch.status ?? current.status;
      if (!isTaskStatus(nextStatus)) {
        throw new InvalidTaskError(
          `Unknown task status: ${String(nextStatus)}`,
        );
      }
      const blocked = decision.action === "blocked";
      if (blocked) nextStatus = "pending";
      if (nextStatus === "running" && nextStartedAt === null) {
        nextStartedAt = normalizeNow(undefined, this.clock);
      }
      if (isTerminalTaskStatus(nextStatus) && nextFinishedAt === null) {
        nextFinishedAt = normalizeNow(undefined, this.clock);
      }
      let nextOwner = hasOwn(patch, "owner")
        ? patch.owner === null
          ? null
          : assertNonEmptyString(patch.owner as string, "owner")
        : current.owner;
      let nextClaimedAt = hasOwn(patch, "claimed_at")
        ? normalizeNullableText(patch.claimed_at, "claimed_at")
        : current.claimed_at;
      let nextLeaseId = hasOwn(patch, "lease_id")
        ? patch.lease_id === null
          ? null
          : assertNonEmptyString(patch.lease_id as string, "lease_id")
        : current.lease_id;
      if (
        blocked ||
        nextStatus === "pending" ||
        nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "blocked" ||
        nextStatus === "cancelled"
      ) {
        nextLeaseId = null;
      }
      if (
        blocked ||
        (hasOwn(patch, "status") &&
          nextStatus === "pending" &&
          current.status !== "pending")
      ) {
        nextOwner = null;
        nextClaimedAt = null;
      }
      if (
        (nextStatus === "claimed" || nextStatus === "running") &&
        (nextOwner === null || nextLeaseId === null)
      ) {
        throw new InvalidTaskError(
          "claimed and running tasks require owner and lease_id",
        );
      }
      if (nextLeaseId !== null && nextLeaseId !== current.lease_id) {
        const lease = this.readLeaseInTransaction(nextLeaseId);
        if (
          lease === null ||
          lease.task_id !== id ||
          lease.released_at !== null
        ) {
          throw new LeaseConflictError(
            nextLeaseId,
            `Lease is not active for task ${id}`,
          );
        }
      }
      if (nextLeaseId === null && current.lease_id !== null) {
        this.db
          .prepare(
            "UPDATE task_leases SET released_at = COALESCE(released_at, ?) WHERE lease_id = ?",
          )
          .run(normalizeNow(undefined, this.clock), current.lease_id);
      }
      const policyEpoch = hasOwn(patch, "policy_epoch")
        ? assertNonNegativeInteger(patch.policy_epoch as number, "policy_epoch")
        : current.policy_epoch;
      const claimedAt =
        nextStatus === "claimed" && nextClaimedAt === null
          ? normalizeNow(undefined, this.clock)
          : nextClaimedAt;
      const bindings: (string | number | null)[] = [
        nextStatus,
        nextOwner,
        nextKind,
        nextEffort,
        nextPriority,
        JSON.stringify(mergedBlockedBy),
        claimedAt,
        nextStartedAt,
        nextFinishedAt,
        JSON.stringify(nextFilesTouched),
        JSON.stringify(nextReadSet),
        JSON.stringify(nextWriteSet),
        nextIsolation,
        explicitSets ? 1 : 0,
        nextLeaseId,
        policyEpoch,
        nextReportId,
        id,
      ];
      let sql = `
        UPDATE tasks SET status = ?, owner = ?, kind = ?, effort = ?, priority = ?,
          blocked_by = ?, claimed_at = ?, started_at = ?, finished_at = ?,
          files_touched = ?, read_set = ?, write_set = ?, isolation = ?,
          sets_explicit = ?, lease_id = ?, version = version + 1,
          policy_epoch = ?, report_id = ?
        WHERE id = ?`;
      if (expectedVersion !== undefined) {
        sql += " AND version = ?";
        bindings.push(expectedVersion);
      }
      if (this.db.prepare(sql).run(...bindings).changes !== 1) {
        throw new VersionConflictError(
          id,
          expectedVersion ?? current.version,
          this.requireTaskInTransaction(id).version,
        );
      }
      this.bumpGraphVersionInTransaction();
      return {
        task: this.requireTaskInTransaction(id),
        created: false,
        decision,
      };
    });
  }

  validateAndUpdate(
    taskId: string,
    patch: TaskUpdate,
    options: RouteOptions = {},
  ): RouteResult {
    return this.routeUpdate(taskId, patch, options);
  }

  read(taskId: string): TaskRecord | null {
    return this.readTask(taskId);
  }

  readTask(taskId: string): TaskRecord | null {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    return this.withReadTransaction(() => this.readTaskInTransaction(id));
  }

  get(taskId: string): TaskRecord | null {
    return this.readTask(taskId);
  }

  getTask(taskId: string): TaskRecord | null {
    return this.readTask(taskId);
  }

  requireTask(taskId: string): TaskRecord {
    const task = this.readTask(taskId);
    if (task === null) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  list(options: ListTasksOptions = {}): TaskRecord[] {
    return this.listTasks(options);
  }

  listTasks(options: ListTasksOptions = {}): TaskRecord[] {
    this.assertOpen();
    const where: string[] = [];
    const params: (string | number | null)[] = [];

    if (options.status !== undefined) {
      const statuses = Array.isArray(options.status)
        ? options.status
        : [options.status];
      if (statuses.length === 0) {
        return [];
      }
      for (const status of statuses) {
        if (!isTaskStatus(status)) {
          throw new InvalidTaskError(`Unknown task status: ${String(status)}`);
        }
      }
      where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
      params.push(...statuses);
    }

    if (options.owner !== undefined) {
      where.push("owner IS ?");
      params.push(
        options.owner === null
          ? null
          : assertNonEmptyString(options.owner, "owner"),
      );
    }

    if (options.lease_id !== undefined) {
      where.push("lease_id IS ?");
      params.push(
        options.lease_id === null
          ? null
          : assertNonEmptyString(options.lease_id, "lease_id"),
      );
    }

    const limit =
      options.limit === undefined
        ? undefined
        : assertNonNegativeInteger(options.limit, "limit");
    const offset =
      options.offset === undefined
        ? undefined
        : assertNonNegativeInteger(options.offset, "offset");

    let sql = TASK_SELECT;
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY id ASC";
    if (limit !== undefined) {
      sql += " LIMIT ?";
      params.push(limit);
      if (offset !== undefined) {
        sql += " OFFSET ?";
        params.push(offset);
      }
    } else if (offset !== undefined) {
      sql += " LIMIT -1 OFFSET ?";
      params.push(offset);
    }

    return this.withReadTransaction(() => {
      const rows = this.db.prepare(sql).all(...params) as TaskRow[];
      return rows.map(rowToTask);
    });
  }

  /**
   * Return only tasks that directly depend on `taskId`.
   *
   * The bridge uses this targeted lookup to compute `blocks` for one task
   * without loading the complete graph. The JSON target is indexed by
   * SQLite's json_each virtual table and remains consistent with the
   * dependency array used by atomic claim/CAS operations.
   */
  listDependents(taskId: string): TaskRecord[] {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    return this.withReadTransaction(() => {
      const rows = this.db
        .prepare(`
          ${TASK_SELECT}
          WHERE EXISTS (
            SELECT 1
            FROM json_each(tasks.blocked_by)
            WHERE json_each.value = ?
          )
          ORDER BY id ASC
        `)
        .all(id) as TaskRow[];
      return rows.map(rowToTask);
    });
  }

  getDependents(taskId: string): TaskRecord[] {
    return this.listDependents(taskId);
  }

  update(
    taskId: string,
    patch: TaskUpdate,
    expectedVersionOrOptions?: ExpectedVersionInput,
  ): TaskRecord {
    return this.updateTask(taskId, patch, expectedVersionOrOptions);
  }

  updateTask(
    taskId: string,
    patch: TaskUpdate,
    expectedVersionOrOptions?: ExpectedVersionInput,
  ): TaskRecord {
    return this.updateTaskInternal(
      taskId,
      patch,
      expectedVersionOrOptions,
      true,
    );
  }

  compareAndSwap(
    taskId: string,
    expectedVersion: number,
    patch: TaskUpdate,
  ): TaskRecord | null {
    try {
      return this.updateTaskInternal(taskId, patch, expectedVersion, false);
    } catch (error) {
      if (error instanceof VersionConflictError) {
        return null;
      }
      throw error;
    }
  }

  updateTaskCAS(
    taskId: string,
    expectedVersion: number,
    patch: TaskUpdate,
  ): TaskRecord | null {
    return this.compareAndSwap(taskId, expectedVersion, patch);
  }

  claim(
    taskId: string,
    owner: string,
    options?: ClaimOptions,
  ): TaskRecord | null;
  claim(taskId: string, request: ClaimRequest): TaskRecord | null;
  claim(
    taskId: string,
    ownerOrRequest: string | ClaimRequest,
    options: ClaimOptions = {},
  ): TaskRecord | null {
    const result =
      typeof ownerOrRequest === "string"
        ? this.claimTask(taskId, ownerOrRequest, options)
        : this.claimTask(taskId, ownerOrRequest.owner, ownerOrRequest);
    return result.ok ? result.task : null;
  }

  tryClaim(taskId: string, owner: string, options?: ClaimOptions): ClaimResult;
  tryClaim(taskId: string, request: ClaimRequest): ClaimResult;
  tryClaim(
    taskId: string,
    ownerOrRequest: string | ClaimRequest,
    options: ClaimOptions = {},
  ): ClaimResult {
    return typeof ownerOrRequest === "string"
      ? this.claimTask(taskId, ownerOrRequest, options)
      : this.claimTask(taskId, ownerOrRequest.owner, ownerOrRequest);
  }

  claimTask(taskId: string, owner: string, options?: ClaimOptions): ClaimResult;
  claimTask(taskId: string, request: ClaimRequest): ClaimResult;
  claimTask(
    taskId: string,
    ownerOrRequest: string | ClaimRequest,
    options: ClaimOptions = {},
  ): ClaimResult {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    const owner =
      typeof ownerOrRequest === "string"
        ? ownerOrRequest
        : ownerOrRequest.owner;
    const claimOptions =
      typeof ownerOrRequest === "string" ? options : ownerOrRequest;
    const normalizedOwner = assertNonEmptyString(owner, "owner");
    const expectedVersion = this.extractExpectedVersion(claimOptions);
    if (expectedVersion !== undefined) {
      assertNonNegativeInteger(expectedVersion, "expected_version");
    }
    const requestedLeaseId = this.normalizeLeaseId(
      claimOptions.lease_id ?? claimOptions.leaseId,
    );
    const ttl = normalizeTtl(
      claimOptions.ttl_ms ?? claimOptions.ttlMs,
      this.leaseTtlMs,
    );
    const now = normalizeNow(claimOptions.now, this.clock);
    const expiresAt = new Date(new Date(now).getTime() + ttl).toISOString();

    return this.withWriteTransaction(() => {
      this.expireLeasesInTransaction(now);

      const current = this.readTaskInTransaction(id);
      if (current === null) {
        return {
          ok: false,
          reason: "not_found",
          task: null,
          blocked_by: [],
        } satisfies ClaimFailure;
      }

      if (
        expectedVersion !== undefined &&
        current.version !== expectedVersion
      ) {
        return {
          ok: false,
          reason: "version_conflict",
          task: current,
          blocked_by: current.blocked_by,
          expected_version: expectedVersion,
          actual_version: current.version,
        } satisfies ClaimFailure;
      }

      if (requestedLeaseId !== undefined) {
        const existingLease = this.readLeaseInTransaction(requestedLeaseId);
        if (existingLease !== null) {
          if (
            existingLease.released_at === null &&
            existingLease.task_id === id &&
            existingLease.owner === normalizedOwner
          ) {
            return {
              ok: true,
              task: current,
              lease: rowToLease(existingLease),
            } satisfies ClaimSuccess;
          }
          return {
            ok: false,
            reason: "lease_conflict",
            task: current,
            blocked_by: current.blocked_by,
          } satisfies ClaimFailure;
        }
      }

      if (current.status !== "pending") {
        return {
          ok: false,
          reason: "status_not_pending",
          task: current,
          blocked_by: current.blocked_by,
        } satisfies ClaimFailure;
      }

      const incomplete = this.incompleteDependenciesInTransaction(
        current.blocked_by,
      );
      if (incomplete.length > 0) {
        return {
          ok: false,
          reason: "dependencies_incomplete",
          task: current,
          blocked_by: incomplete,
        } satisfies ClaimFailure;
      }

      const activeLease = this.readActiveLeaseForTaskInTransaction(id);
      if (activeLease !== null) {
        return {
          ok: false,
          reason: "lease_active",
          task: current,
          blocked_by: current.blocked_by,
        } satisfies ClaimFailure;
      }

      const leaseId = requestedLeaseId ?? randomUUID();
      const changes = this.db
        .prepare(`
          UPDATE tasks
          SET status = 'claimed',
              owner = ?,
              claimed_at = ?,
              lease_id = ?,
              version = version + 1
          WHERE id = ?
            AND status = 'pending'
            AND version = ?
            AND NOT EXISTS (
              SELECT 1 FROM task_leases
              WHERE task_id = tasks.id AND released_at IS NULL
            )
            AND NOT EXISTS (
              SELECT 1
              FROM json_each(tasks.blocked_by) AS dependency_id
              LEFT JOIN tasks AS dependency ON dependency.id = dependency_id.value
              WHERE dependency.id IS NULL OR dependency.status <> 'completed'
            )
        `)
        .run(normalizedOwner, now, leaseId, id, current.version).changes;

      if (changes !== 1) {
        const latest = this.readTaskInTransaction(id);
        if (latest === null) {
          return {
            ok: false,
            reason: "not_found",
            task: null,
            blocked_by: [],
          } satisfies ClaimFailure;
        }
        return {
          ok: false,
          reason:
            latest.version !== current.version
              ? "version_conflict"
              : latest.status !== "pending"
                ? "status_not_pending"
                : "dependencies_incomplete",
          task: latest,
          blocked_by: this.incompleteDependenciesInTransaction(
            latest.blocked_by,
          ),
          expected_version: expectedVersion,
          actual_version: latest.version,
        } satisfies ClaimFailure;
      }

      this.db
        .prepare(`
          INSERT INTO task_leases(
            lease_id, task_id, owner, acquired_at, expires_at, released_at
          ) VALUES (?, ?, ?, ?, ?, NULL)
        `)
        .run(leaseId, id, normalizedOwner, now, expiresAt);
      this.bumpGraphVersionInTransaction();

      const task = this.requireTaskInTransaction(id);
      const lease = this.requireLeaseInTransaction(leaseId);
      return { ok: true, task, lease } satisfies ClaimSuccess;
    });
  }

  acquireLease(
    taskId: string,
    owner: string,
    options?: ClaimOptions,
  ): TaskLease | null {
    const result = this.claimTask(taskId, owner, options);
    return result.ok ? result.lease : null;
  }

  getLease(leaseId: string): TaskLease | null {
    this.assertOpen();
    const id = this.normalizeLeaseId(leaseId);
    if (id === undefined) {
      return null;
    }
    const row = this.readLeaseInTransaction(id);
    return row === null ? null : rowToLease(row);
  }

  getTaskLease(taskId: string): TaskLease | null {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    const row = this.readActiveLeaseForTaskInTransaction(id);
    return row === null ? null : rowToLease(row);
  }

  releaseLease(
    leaseId: string,
    options: LeaseReleaseOptions | string = {},
  ): TaskLease | null {
    this.assertOpen();
    const id = this.normalizeLeaseId(leaseId);
    if (id === undefined) {
      return null;
    }
    const releaseOptions: LeaseReleaseOptions =
      typeof options === "string" ? { owner: options } : options;
    const owner =
      releaseOptions.owner === undefined
        ? undefined
        : assertNonEmptyString(releaseOptions.owner, "owner");
    const now = normalizeNow(releaseOptions.now, this.clock);

    return this.withWriteTransaction(() => {
      const lease = this.readLeaseInTransaction(id);
      if (lease === null) {
        return null;
      }
      if (owner !== undefined && lease.owner !== owner) {
        throw new LeaseOwnerMismatchError(id);
      }
      if (lease.released_at !== null) {
        return rowToLease(lease);
      }

      const task = this.readTaskInTransaction(lease.task_id);
      this.db
        .prepare(
          "UPDATE task_leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL",
        )
        .run(now, id);

      if (task !== null && task.lease_id === id) {
        if (task.status === "claimed" || task.status === "running") {
          this.db
            .prepare(`
              UPDATE tasks
              SET status = 'pending', owner = NULL, claimed_at = NULL,
                  lease_id = NULL, version = version + 1
              WHERE id = ? AND lease_id = ?
            `)
            .run(task.id, id);
        } else {
          this.db
            .prepare(`
              UPDATE tasks
              SET lease_id = NULL, version = version + 1
              WHERE id = ? AND lease_id = ?
            `)
            .run(task.id, id);
        }
        this.bumpGraphVersionInTransaction();
      } else {
        this.bumpGraphVersionInTransaction();
      }

      return this.requireLeaseInTransaction(id);
    });
  }

  release(taskId: string, leaseId?: string): TaskLease | null {
    if (leaseId === undefined) {
      const lease = this.getTaskLease(taskId);
      return lease === null ? null : this.releaseLease(lease.lease_id);
    }
    const task = this.readTask(taskId);
    if (task === null || task.lease_id !== leaseId) {
      return null;
    }
    return this.releaseLease(leaseId);
  }

  releaseTaskLease(
    taskId: string,
    leaseId: string,
    options?: LeaseReleaseOptions | string,
  ): TaskLease | null {
    const task = this.readTask(taskId);
    if (task === null || task.lease_id !== leaseId) {
      return null;
    }
    return this.releaseLease(leaseId, options);
  }

  expireLeases(at?: string | Date): RecoveryResult {
    this.assertOpen();
    const now = normalizeNow(at, this.clock);
    return this.withWriteTransaction(() => this.expireLeasesInTransaction(now));
  }

  recover(at?: string | Date): RecoveryResult {
    return this.expireLeases(at);
  }

  recoverExpiredLeases(at?: string | Date): RecoveryResult {
    return this.expireLeases(at);
  }

  snapshot(): TaskGraphSnapshot {
    this.assertOpen();
    return this.withReadTransaction(() => {
      const tasks = (
        this.db.prepare(`${TASK_SELECT} ORDER BY id ASC`).all() as TaskRow[]
      ).map(rowToTask);
      const version = this.readGraphVersionInTransaction();
      const snapshot: TaskGraphSnapshot = {
        version,
        graph_version: version,
        captured_at: normalizeNow(undefined, this.clock),
        tasks,
      };
      return deepFreeze(snapshot);
    });
  }

  getSnapshot(): TaskGraphSnapshot {
    return this.snapshot();
  }

  snapshotTasks(): readonly TaskRecord[] {
    return this.snapshot().tasks;
  }

  graphVersion(): number {
    this.assertOpen();
    return this.readGraphVersionInTransaction();
  }

  close(): void {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  [Symbol.dispose](): void {
    this.close();
  }

  private updateTaskInternal(
    taskId: string,
    patch: TaskUpdate,
    expectedVersionOrOptions: ExpectedVersionInput,
    throwOnConflict: boolean,
  ): TaskRecord {
    this.assertOpen();
    const id = assertNonEmptyString(taskId, "id");
    const expectedVersion = this.extractExpectedVersion(
      expectedVersionOrOptions,
      patch,
    );
    if (expectedVersion !== undefined) {
      assertNonNegativeInteger(expectedVersion, "expected_version");
    }

    return this.withWriteTransaction(() => {
      const current = this.readTaskInTransaction(id);
      if (current === null) {
        throw new TaskNotFoundError(id);
      }
      if (
        expectedVersion !== undefined &&
        current.version !== expectedVersion
      ) {
        const conflict = new VersionConflictError(
          id,
          expectedVersion,
          current.version,
        );
        if (throwOnConflict) {
          throw conflict;
        }
        throw conflict;
      }

      const mutableKeys = [
        "status",
        "owner",
        "kind",
        "effort",
        "priority",
        "blocked_by",
        "depends_on",
        "claimed_at",
        "started_at",
        "finished_at",
        "files_touched",
        "read_set",
        "write_set",
        "isolation",
        "lease_id",
        "policy_epoch",
        "report_id",
      ] as const;
      if (!mutableKeys.some((key) => hasOwn(patch, key))) {
        return current;
      }

      const nextStatus = patch.status ?? current.status;
      if (!isTaskStatus(nextStatus)) {
        throw new InvalidTaskError(
          `Unknown task status: ${String(nextStatus)}`,
        );
      }
      let nextOwner = hasOwn(patch, "owner")
        ? patch.owner === null
          ? null
          : assertNonEmptyString(patch.owner as string, "owner")
        : current.owner;
      const nextKind = hasOwn(patch, "kind")
        ? normalizeKind(patch.kind)
        : current.kind;
      const nextEffort = hasOwn(patch, "effort")
        ? normalizeEffort(patch.effort)
        : current.effort;
      const nextPriority = hasOwn(patch, "priority")
        ? normalizePriority(patch.priority)
        : current.priority;
      const nextBlockedBy =
        hasOwn(patch, "blocked_by") || hasOwn(patch, "depends_on")
          ? normalizeStringArray(
              (patch.blocked_by ?? patch.depends_on) as
                | readonly string[]
                | undefined,
              "blocked_by",
            )
          : current.blocked_by;
      let nextClaimedAt = hasOwn(patch, "claimed_at")
        ? normalizeNullableText(patch.claimed_at, "claimed_at")
        : current.claimed_at;
      let nextStartedAt = hasOwn(patch, "started_at")
        ? normalizeNullableText(patch.started_at, "started_at")
        : current.started_at;
      let nextFinishedAt = hasOwn(patch, "finished_at")
        ? normalizeNullableText(patch.finished_at, "finished_at")
        : current.finished_at;
      const nextFilesTouched = hasOwn(patch, "files_touched")
        ? normalizeTargets(patch.files_touched, "files_touched")
        : current.files_touched;
      const nextReadSet = hasOwn(patch, "read_set")
        ? normalizeTargets(patch.read_set, "read_set")
        : current.read_set;
      const nextWriteSet = hasOwn(patch, "write_set")
        ? normalizeTargets(patch.write_set, "write_set")
        : current.write_set;
      const nextIsolation = hasOwn(patch, "isolation")
        ? this.normalizeIsolation(patch.isolation)
        : current.isolation;
      const nextSetsExplicit =
        hasOwn(patch, "read_set") || hasOwn(patch, "write_set")
          ? true
          : this.hasExplicitSets(current);
      let nextLeaseId = hasOwn(patch, "lease_id")
        ? patch.lease_id === null
          ? null
          : assertNonEmptyString(patch.lease_id as string, "lease_id")
        : current.lease_id;
      const nextPolicyEpoch = hasOwn(patch, "policy_epoch")
        ? assertNonNegativeInteger(patch.policy_epoch as number, "policy_epoch")
        : current.policy_epoch;
      const nextReportId = hasOwn(patch, "report_id")
        ? normalizeNullableText(patch.report_id, "report_id")
        : current.report_id;

      if (nextStatus === "running" && nextStartedAt === null) {
        nextStartedAt = normalizeNow(undefined, this.clock);
      }
      if (isTerminalTaskStatus(nextStatus) && nextFinishedAt === null) {
        nextFinishedAt = normalizeNow(undefined, this.clock);
      }

      if (hasOwn(patch, "blocked_by") || hasOwn(patch, "depends_on")) {
        this.validateDependenciesInTransaction(id, nextBlockedBy);
      }

      if (
        nextStatus === "pending" ||
        nextStatus === "completed" ||
        nextStatus === "failed" ||
        nextStatus === "blocked" ||
        nextStatus === "cancelled"
      ) {
        nextLeaseId = null;
      }
      if (
        hasOwn(patch, "status") &&
        nextStatus === "pending" &&
        current.status !== "pending"
      ) {
        // Returning a task to the queue also removes the previous claimant.
        // Terminal states retain owner/claimed_at as historical metadata.
        nextOwner = null;
        nextClaimedAt = null;
      }
      if (
        (nextStatus === "claimed" || nextStatus === "running") &&
        (nextOwner === null || nextLeaseId === null)
      ) {
        throw new InvalidTaskError(
          "claimed and running tasks require owner and lease_id",
        );
      }

      if (nextLeaseId !== null && nextLeaseId !== current.lease_id) {
        const lease = this.readLeaseInTransaction(nextLeaseId);
        if (
          lease === null ||
          lease.task_id !== id ||
          lease.released_at !== null
        ) {
          throw new LeaseConflictError(
            nextLeaseId,
            `Lease is not active for task ${id}`,
          );
        }
      }

      if (nextLeaseId === null && current.lease_id !== null) {
        this.db
          .prepare(`
            UPDATE task_leases
            SET released_at = COALESCE(released_at, ?)
            WHERE lease_id = ?
          `)
          .run(normalizeNow(undefined, this.clock), current.lease_id);
      }

      const claimedAt =
        nextStatus === "claimed" && nextClaimedAt === null
          ? normalizeNow(undefined, this.clock)
          : nextClaimedAt;
      const updateSql =
        expectedVersion === undefined
          ? `
            UPDATE tasks
            SET status = ?, owner = ?, kind = ?, effort = ?, priority = ?,
              blocked_by = ?, claimed_at = ?, started_at = ?, finished_at = ?,
              files_touched = ?, read_set = ?, write_set = ?,
                isolation = ?, sets_explicit = ?, lease_id = ?,
                version = version + 1, policy_epoch = ?, report_id = ?
            WHERE id = ?
          `
          : `
            UPDATE tasks
            SET status = ?, owner = ?, kind = ?, effort = ?, priority = ?,
              blocked_by = ?, claimed_at = ?, started_at = ?, finished_at = ?,
              files_touched = ?, read_set = ?, write_set = ?,
                isolation = ?, sets_explicit = ?, lease_id = ?,
                version = version + 1, policy_epoch = ?, report_id = ?
            WHERE id = ? AND version = ?
          `;
      const bindings: (string | number | null)[] = [
        nextStatus,
        nextOwner,
        nextKind,
        nextEffort,
        nextPriority,
        JSON.stringify(nextBlockedBy),
        claimedAt,
        nextStartedAt,
        nextFinishedAt,
        JSON.stringify(nextFilesTouched),
        JSON.stringify(nextReadSet),
        JSON.stringify(nextWriteSet),
        nextIsolation,
        nextSetsExplicit ? 1 : 0,
        nextLeaseId,
        nextPolicyEpoch,
        nextReportId,
        id,
      ];
      if (expectedVersion !== undefined) {
        bindings.push(expectedVersion);
      }
      const changes = this.db.prepare(updateSql).run(...bindings).changes;
      if (changes !== 1) {
        const latest = this.requireTaskInTransaction(id);
        const actual = latest.version;
        if (expectedVersion !== undefined) {
          throw new VersionConflictError(id, expectedVersion, actual);
        }
        throw new TaskGraphError(
          "INVALID_TASK",
          `Task update did not affect ${id}`,
        );
      }
      this.bumpGraphVersionInTransaction();
      return this.requireTaskInTransaction(id);
    });
  }

  private normalizeIsolation(value: TaskIsolation | undefined): TaskIsolation {
    const isolation = value ?? "shared";
    if (isolation !== "shared" && isolation !== "worktree") {
      throw new InvalidTaskError(
        `isolation must be 'shared' or 'worktree', got ${String(isolation)}`,
      );
    }
    return isolation;
  }

  private hasExplicitSets(task: TaskRecord): boolean {
    const row = this.db
      .prepare("SELECT sets_explicit FROM tasks WHERE id = ?")
      .get(task.id) as { sets_explicit: number } | null | undefined;
    return row?.sets_explicit === 1;
  }

  private readAllTasksInTransaction(): TaskRecord[] {
    return (
      this.db.prepare(`${TASK_SELECT} ORDER BY id ASC`).all() as TaskRow[]
    ).map(rowToTask);
  }

  private insertTaskInTransaction(input: {
    id: string;
    status: TaskStatus;
    owner: string | null;
    kind: TaskKind;
    effort: TaskEffort;
    priority: number;
    blockedBy: readonly string[];
    claimedAt: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    filesTouched: readonly string[];
    readSet: readonly string[];
    writeSet: readonly string[];
    isolation: TaskIsolation;
    setsExplicit: boolean;
    leaseId: string | null;
    policyEpoch: number;
    reportId: string | null;
  }): void {
    try {
      this.db
        .prepare(`
          INSERT INTO tasks(
            id, status, owner, kind, effort, priority, blocked_by, claimed_at,
            started_at, finished_at,
            files_touched, read_set, write_set, isolation, sets_explicit,
            lease_id, version, policy_epoch, report_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `)
        .run(
          input.id,
          input.status,
          input.owner,
          input.kind,
          input.effort,
          input.priority,
          JSON.stringify(input.blockedBy),
          input.claimedAt,
          input.startedAt,
          input.finishedAt,
          JSON.stringify(input.filesTouched),
          JSON.stringify(input.readSet),
          JSON.stringify(input.writeSet),
          input.isolation,
          input.setsExplicit ? 1 : 0,
          input.leaseId,
          input.policyEpoch,
          input.reportId,
        );
    } catch (error) {
      if (this.isConstraintError(error)) {
        throw new DuplicateTaskError(input.id);
      }
      throw error;
    }
  }

  private expireLeasesInTransaction(now: string): RecoveryResult {
    const rows = this.db
      .prepare(`
        SELECT lease_id, task_id, owner, acquired_at, expires_at, released_at
        FROM task_leases
        WHERE released_at IS NULL AND expires_at <= ?
        ORDER BY expires_at ASC, lease_id ASC
      `)
      .all(now) as LeaseRow[];
    const expiredLeases: TaskLease[] = [];
    const recoveredTasks: TaskRecord[] = [];

    for (const row of rows) {
      const task = this.readTaskInTransaction(row.task_id);
      this.db
        .prepare(
          "UPDATE task_leases SET released_at = ? WHERE lease_id = ? AND released_at IS NULL",
        )
        .run(now, row.lease_id);

      if (task !== null && task.lease_id === row.lease_id) {
        let recoveredTask: TaskRecord;
        if (task.status === "claimed" || task.status === "running") {
          const changes = this.db
            .prepare(`
              UPDATE tasks
              SET status = 'pending', owner = NULL, claimed_at = NULL,
                  lease_id = NULL, version = version + 1
              WHERE id = ? AND lease_id = ?
            `)
            .run(task.id, row.lease_id).changes;
          recoveredTask =
            changes === 1
              ? {
                  ...task,
                  status: "pending",
                  owner: null,
                  claimed_at: null,
                  lease_id: null,
                  version: task.version + 1,
                }
              : this.requireTaskInTransaction(task.id);
        } else {
          const changes = this.db
            .prepare(
              "UPDATE tasks SET lease_id = NULL, version = version + 1 WHERE id = ? AND lease_id = ?",
            )
            .run(task.id, row.lease_id).changes;
          recoveredTask =
            changes === 1
              ? { ...task, lease_id: null, version: task.version + 1 }
              : this.requireTaskInTransaction(task.id);
        }
        this.bumpGraphVersionInTransaction();
        recoveredTasks.push(recoveredTask);
      } else {
        this.bumpGraphVersionInTransaction();
      }

      expiredLeases.push({ ...rowToLease(row), released_at: now });
    }

    return {
      expired_leases: expiredLeases,
      recovered_tasks: recoveredTasks,
      leases: expiredLeases,
      tasks: recoveredTasks,
    };
  }

  private validateDependenciesInTransaction(
    taskId: string,
    dependencies: readonly string[],
  ): void {
    const normalizedTaskId = assertNonEmptyString(taskId, "id");
    const normalizedDependencies = normalizeStringArray(
      dependencies,
      "blocked_by",
    );
    if (normalizedDependencies.includes(normalizedTaskId)) {
      throw new DependencyCycleError([normalizedTaskId, normalizedTaskId]);
    }

    const rows = this.db
      .prepare("SELECT id, blocked_by FROM tasks")
      .all() as DependencyRow[];
    const graph = new Map<string, string[]>();
    for (const row of rows) {
      graph.set(row.id, parseStringArray(row.blocked_by, "blocked_by"));
    }
    graph.set(normalizedTaskId, normalizedDependencies);

    for (const dependencyId of normalizedDependencies) {
      if (!graph.has(dependencyId)) {
        throw new DependencyNotFoundError(normalizedTaskId, dependencyId);
      }
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const path: string[] = [];
    const visit = (node: string): void => {
      if (visiting.has(node)) {
        const cycleStart = path.indexOf(node);
        throw new DependencyCycleError([...path.slice(cycleStart), node]);
      }
      if (visited.has(node)) {
        return;
      }
      visiting.add(node);
      path.push(node);
      for (const dependency of graph.get(node) ?? []) {
        visit(dependency);
      }
      path.pop();
      visiting.delete(node);
      visited.add(node);
    };

    for (const node of graph.keys()) {
      visit(node);
    }
  }

  private incompleteDependenciesInTransaction(
    dependencies: readonly string[],
  ): string[] {
    if (dependencies.length === 0) {
      return [];
    }

    const uniqueDependencies = [...new Set(dependencies)];
    const placeholders = uniqueDependencies.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders})`)
      .all(...uniqueDependencies) as DependencyStatusRow[];
    const statusById = new Map(rows.map((row) => [row.id, row.status]));

    // Preserve the caller's order, including duplicate IDs from legacy data.
    return dependencies.filter(
      (dependencyId) => statusById.get(dependencyId) !== "completed",
    );
  }

  private readTaskInTransaction(taskId: string): TaskRecord | null {
    const row = this.db.prepare(`${TASK_SELECT} WHERE id = ?`).get(taskId) as
      | TaskRow
      | null
      | undefined;
    return row == null ? null : rowToTask(row);
  }

  private requireTaskInTransaction(taskId: string): TaskRecord {
    const task = this.readTaskInTransaction(taskId);
    if (task === null) {
      throw new TaskNotFoundError(taskId);
    }
    return task;
  }

  private readLeaseInTransaction(leaseId: string): LeaseRow | null {
    const row = this.db
      .prepare(`
        SELECT lease_id, task_id, owner, acquired_at, expires_at, released_at
        FROM task_leases WHERE lease_id = ?
      `)
      .get(leaseId) as LeaseRow | null | undefined;
    return row ?? null;
  }

  private requireLeaseInTransaction(leaseId: string): TaskLease {
    const lease = this.readLeaseInTransaction(leaseId);
    if (lease === null) {
      throw new TaskGraphError(
        "LEASE_CONFLICT",
        `Lease does not exist: ${leaseId}`,
      );
    }
    return rowToLease(lease);
  }

  private readActiveLeaseForTaskInTransaction(taskId: string): LeaseRow | null {
    const row = this.db
      .prepare(`
        SELECT lease_id, task_id, owner, acquired_at, expires_at, released_at
        FROM task_leases
        WHERE task_id = ? AND released_at IS NULL
        LIMIT 1
      `)
      .get(taskId) as LeaseRow | null | undefined;
    return row ?? null;
  }

  private bumpGraphVersionInTransaction(): number {
    this.db
      .prepare(`
        UPDATE task_graph_meta
        SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
        WHERE key = 'graph_version'
      `)
      .run();
    return this.readGraphVersionInTransaction();
  }

  private readGraphVersionInTransaction(): number {
    const row = this.db
      .prepare("SELECT value FROM task_graph_meta WHERE key = 'graph_version'")
      .get() as GraphVersionRow | null | undefined;
    if (row == null) {
      throw new TaskGraphError("INVALID_TASK", "Missing task graph version");
    }
    const version = Number(row.value);
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new TaskGraphError("INVALID_TASK", "Invalid task graph version");
    }
    return version;
  }

  private extractExpectedVersion(
    input: ExpectedVersionInput | ClaimOptions,
    patch?: TaskUpdate,
  ): number | undefined {
    if (typeof input === "number") {
      return input;
    }
    if (input !== undefined) {
      const options = input as UpdateOptions | ClaimOptions;
      const explicit =
        "expectedVersion" in options
          ? options.expectedVersion
          : options.expected_version;
      if (explicit !== undefined) {
        return explicit;
      }
    }
    if (patch?.expectedVersion !== undefined) {
      return patch.expectedVersion;
    }
    if (patch?.expected_version !== undefined) {
      return patch.expected_version;
    }
    if (patch?.version !== undefined) {
      return patch.version;
    }
    return undefined;
  }

  private normalizeLeaseId(value: string | undefined): string | undefined {
    return value === undefined
      ? undefined
      : assertNonEmptyString(value, "lease_id");
  }

  private isConstraintError(error: unknown): boolean {
    return error instanceof Error && /constraint|unique/i.test(error.message);
  }

  private withWriteTransaction<T>(callback: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database or validation error.
      }
      throw error;
    }
  }

  private withReadTransaction<T>(callback: () => T): T {
    this.assertOpen();
    this.db.exec("BEGIN");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original database or validation error.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new DatabaseClosedError();
    }
  }
}

export const TaskGraphStore = TaskGraph;
export const SQLiteTaskGraph = TaskGraph;
export const TaskGraphCore = TaskGraph;

export function createTaskGraph(options: TaskGraphOptions = {}): TaskGraph {
  return new TaskGraph(options);
}

export function openTaskGraph(options: TaskGraphOptions = {}): TaskGraph {
  return new TaskGraph(options);
}

export type {
  ClaimFailure,
  ClaimOptions,
  ClaimRequest,
  ClaimResult,
  ClaimSuccess,
  CreateTaskInput,
  LeaseReleaseOptions,
  ListTasksOptions,
  RecoveryResult,
  RouteOptions,
  RouteResult,
  RouteTaskInput,
  TaskEffort,
  TaskGraphOptions,
  TaskGraphSnapshot,
  TaskKind,
  TaskIsolation,
  TaskLease,
  TaskRecord,
  TaskStatus,
  TaskUpdate,
  UpdateOptions,
} from "./types.js";

export default TaskGraph;
