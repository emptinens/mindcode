import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getTaskGraphPaths } from "../storage/taskGraphPaths.js";
import { TaskGraphDaemonClient } from "../runtime/taskGraph/client.js";
import type { DaemonCallResult } from "../runtime/daemon/types.js";
import type { TaskGraphListParams } from "../runtime/taskGraph/protocol.js";
import { DuplicateTaskError } from "../tasks/graph/errors.js";
import { type TaskGraph, openTaskGraph } from "../tasks/graph/taskGraph.js";
import type {
  ClaimFailure,
  ClaimResult,
  TaskStatus as GraphTaskStatus,
  RouteTaskInput,
  TaskEffort,
  TaskKind,
  TaskRecord,
  TaskGraphSnapshot,
} from "../tasks/graph/types.js";
import { normalizeTargets } from "../tasks/validation/targets.js";
import { getMindCodeConfigHomeDir } from "./envUtils.js";

export const GRAPH_TASK_STATUSES = [
  "pending",
  "claimed",
  "running",
  "completed",
  "failed",
] as const;

export type GraphTaskStatusName = (typeof GRAPH_TASK_STATUSES)[number];
export type CompatibleTaskStatus = GraphTaskStatusName | "in_progress";
export type TaskMetadata = Record<string, unknown>;

export type LegacyTask = {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  status?: string;
  owner?: string;
  blocks?: string[];
  blockedBy?: string[];
  metadata?: TaskMetadata;
};

export type BridgeTask = {
  id: string;
  subject: string;
  description: string;
  activeForm?: string;
  owner?: string;
  kind: TaskKind;
  effort: TaskEffort;
  priority: number;
  status: CompatibleTaskStatus;
  blocks: string[];
  blockedBy: string[];
  files_touched: string[];
  read_set: string[];
  write_set: string[];
  started_at: string | null;
  finished_at: string | null;
  policy_epoch: number;
  policy_digest?: string | null;
  report_id: string | null;
  metadata?: TaskMetadata;
};

export type BridgeTaskPatch = {
  subject?: string;
  description?: string;
  activeForm?: string;
  status?: CompatibleTaskStatus;
  owner?: string | null;
  kind?: TaskKind;
  effort?: TaskEffort;
  priority?: number;
  blockedBy?: readonly string[];
  files_touched?: readonly string[];
  read_set?: readonly string[];
  write_set?: readonly string[];
  isolation?: "shared" | "worktree";
  started_at?: string | null;
  finished_at?: string | null;
  policy_epoch?: number;
  policy_digest?: string | null;
  report_id?: string | null;
  metadata?: TaskMetadata;
};

export type BridgeCreateInput = Omit<
  BridgeTask,
  | "id"
  | "kind"
  | "effort"
  | "priority"
  | "files_touched"
  | "read_set"
  | "write_set"
  | "started_at"
  | "finished_at"
  | "policy_epoch"
  | "report_id"
> & {
  id?: string;
  kind?: TaskKind;
  effort?: TaskEffort;
  priority?: number;
  files_touched?: readonly string[];
  read_set?: readonly string[];
  write_set?: readonly string[];
  started_at?: string | null;
  finished_at?: string | null;
  policy_epoch?: number;
  policy_digest?: string | null;
  report_id?: string | null;
};

export type BridgeClaimResult =
  | { success: true; task: BridgeTask }
  | {
      success: false;
      reason:
        | "task_not_found"
        | "already_claimed"
        | "already_resolved"
        | "blocked"
        | "agent_busy";
      task?: BridgeTask;
      busyWithTasks?: string[];
      blockedByTasks?: string[];
    };

const STORAGE_PREFIX = "mindcode-team-v2:";
const TARGET_ROOT = ".mindcode-tasklists";

const DETAILS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS task_graph_details (
    task_id TEXT PRIMARY KEY NOT NULL,
    task_list_id TEXT NOT NULL,
    public_id TEXT NOT NULL,
    subject TEXT NOT NULL,
    description TEXT NOT NULL,
    active_form TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    deleted INTEGER NOT NULL DEFAULT 0 CHECK (deleted IN (0, 1))
  );
  CREATE INDEX IF NOT EXISTS task_graph_details_list_idx
    ON task_graph_details(task_list_id, deleted);
  CREATE TABLE IF NOT EXISTS task_graph_bridge_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
`;

type DetailRow = {
  task_id: string;
  task_list_id: string;
  public_id: string;
  subject: string;
  description: string;
  active_form: string | null;
  metadata: string;
  deleted: number;
};

type StoredTaskRow = {
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
  policy_digest: string | null;
  report_id: string | null;
};

function encodeNamespace(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeNamespace(value: string): string | null {
  try {
    return Buffer.from(value, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function taskNamespacePrefix(taskListId: string): string {
  return `${STORAGE_PREFIX}${encodeNamespace(taskListId)}:`;
}

function storageTaskId(taskListId: string, publicId: string): string {
  const normalized = publicId.trim();
  if (!normalized) throw new Error("Task ID must be non-empty");
  return `${taskNamespacePrefix(taskListId)}${encodeNamespace(normalized)}`;
}

function publicTaskId(taskListId: string, storedId: string): string | null {
  const prefix = taskNamespacePrefix(taskListId);
  if (!storedId.startsWith(prefix)) return null;
  return decodeNamespace(storedId.slice(prefix.length));
}

function targetNamespacePrefix(taskListId: string): string {
  return `${TARGET_ROOT}/${encodeNamespace(taskListId)}/`;
}

function namespaceTarget(taskListId: string, target: string): string {
  const prefix = targetNamespacePrefix(taskListId);
  return target.startsWith(prefix) ? target : `${prefix}${target}`;
}

function namespaceTargets(
  taskListId: string,
  targets: readonly string[] | undefined,
  field: string,
): string[] | undefined {
  return targets === undefined
    ? undefined
    : normalizeTargets(targets, field).map((target) =>
        namespaceTarget(taskListId, target),
      );
}

function namespaceDependencies(
  taskListId: string,
  dependencies: readonly string[] | undefined,
): string[] | undefined {
  return dependencies?.map((id) =>
    publicTaskId(taskListId, id) === null ? storageTaskId(taskListId, id) : id,
  );
}

function publicDependencies(
  taskListId: string,
  dependencies: readonly string[],
): string[] {
  return dependencies.map((id) => publicTaskId(taskListId, id) ?? id);
}

function sanitizePathComponent(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function legacyTasksDir(taskListId: string): string {
  return join(
    getMindCodeConfigHomeDir(),
    "tasks",
    sanitizePathComponent(taskListId),
  );
}

function graphStatus(status: string | undefined): GraphTaskStatusName {
  if (status === "running" || status === "in_progress") return "running";
  if (status === "claimed") return "claimed";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "pending";
}

function externalStatus(status: GraphTaskStatus): CompatibleTaskStatus {
  return status === "blocked" || status === "cancelled" ? "failed" : status;
}

function asMetadata(value: unknown): TaskMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return { ...(value as TaskMetadata) };
}

function parseMetadata(value: string | null | undefined): TaskMetadata {
  if (!value) return {};
  try {
    return asMetadata(JSON.parse(value));
  } catch {
    return {};
  }
}

function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function structuralMetadata(metadata: TaskMetadata | undefined): {
  files_touched?: string[];
  read_set?: string[];
  write_set?: string[];
  isolation?: "shared" | "worktree";
} {
  const value = metadata ?? {};
  const filesValue = value.files_touched ?? value.filesTouched;
  const readValue = value.read_set ?? value.readSet;
  const writeValue = value.write_set ?? value.writeSet;
  const isolation = value.isolation;
  return {
    files_touched: filesValue === null ? [] : stringArray(filesValue),
    read_set: readValue === null ? [] : stringArray(readValue),
    write_set: writeValue === null ? [] : stringArray(writeValue),
    isolation:
      isolation === "worktree"
        ? "worktree"
        : isolation === "shared" || isolation === null
          ? "shared"
          : undefined,
  };
}

function ensureDetailsSchema(db: Database): void {
  db.exec(DETAILS_SCHEMA);
  const columns = db
    .prepare("PRAGMA table_info(task_graph_details)")
    .all() as Array<{
    name: string;
  }>;
  if (!columns.some((column) => column.name === "public_id")) {
    try {
      db.exec("ALTER TABLE task_graph_details ADD COLUMN public_id TEXT");
    } catch (error) {
      const migratedColumns = db
        .prepare("PRAGMA table_info(task_graph_details)")
        .all() as Array<{ name: string }>;
      if (!migratedColumns.some((column) => column.name === "public_id")) {
        throw error;
      }
    }
  }
  db.exec(`
    UPDATE task_graph_details
    SET public_id = task_id
    WHERE public_id IS NULL OR public_id = '';
  `);
  const indexes = db
    .prepare("PRAGMA index_list(task_graph_details)")
    .all() as Array<{
    name: string;
  }>;
  if (indexes.some((index) => index.name === "task_graph_details_public_idx")) {
    db.exec("DROP INDEX task_graph_details_public_idx");
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS task_graph_details_public_lookup_idx
      ON task_graph_details(task_list_id, public_id)
  `);
}

function openDetailsDb(): Database {
  const { databasePath, stateDir } = getTaskGraphPaths();
  mkdirSync(stateDir, { recursive: true });
  const db = new Database(databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  ensureDetailsSchema(db);
  return db;
}

function readDetailsForList(
  db: Database,
  taskListId: string,
): Map<string, DetailRow> {
  const rows = db
    .prepare(
      "SELECT * FROM task_graph_details WHERE task_list_id = ? AND deleted = 0",
    )
    .all(taskListId) as DetailRow[];
  return new Map(rows.map((row) => [row.task_id, row]));
}

function readDetail(
  db: Database,
  taskListId: string,
  publicId: string,
): DetailRow | undefined {
  return db
    .prepare(
      "SELECT * FROM task_graph_details WHERE task_list_id = ? AND public_id = ?",
    )
    .get(taskListId, publicId) as DetailRow | undefined;
}

function writeDetail(
  db: Database,
  taskListId: string,
  task: BridgeCreateInput,
  deleted = false,
): void {
  if (!task.id) throw new Error("Task detail requires a public ID");
  const storedId = storageTaskId(taskListId, task.id);
  db.prepare(`
    INSERT INTO task_graph_details(
      task_id, task_list_id, public_id, subject, description,
      active_form, metadata, deleted
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      task_list_id = excluded.task_list_id,
      public_id = excluded.public_id,
      subject = excluded.subject,
      description = excluded.description,
      active_form = excluded.active_form,
      metadata = excluded.metadata,
      deleted = excluded.deleted
  `).run(
    storedId,
    taskListId,
    task.id,
    task.subject,
    task.description,
    task.activeForm ?? null,
    JSON.stringify(task.metadata ?? {}),
    deleted ? 1 : 0,
  );
}

function patchDetail(
  db: Database,
  taskListId: string,
  publicId: string,
  current: DetailRow | undefined,
  patch: BridgeTaskPatch,
  metadata: TaskMetadata,
): void {
  writeDetail(db, taskListId, {
    id: publicId,
    subject: patch.subject ?? current?.subject ?? `Task ${publicId}`,
    description: patch.description ?? current?.description ?? "",
    activeForm: patch.activeForm ?? current?.active_form ?? undefined,
    status: "pending",
    blocks: [],
    blockedBy: [],
    metadata,
  });
}

function normalizeGraphRecord(
  taskListId: string,
  record: TaskRecord,
  detail: DetailRow | undefined,
  dependentRecords: readonly TaskRecord[],
): BridgeTask | null {
  if (!detail || detail.task_list_id !== taskListId || detail.deleted)
    return null;
  const publicId = publicTaskId(taskListId, record.id);
  if (!publicId || detail.public_id !== publicId) return null;
  const metadata = parseMetadata(detail.metadata);
  const blocks = dependentRecords
    .map((task) => publicTaskId(taskListId, task.id))
    .filter((id): id is string => id !== null)
    .sort();
  return {
    id: publicId,
    subject: detail.subject,
    description: detail.description,
    activeForm: detail.active_form ?? undefined,
    owner: record.owner ?? undefined,
    kind: record.kind,
    effort: record.effort,
    priority: record.priority,
    status: externalStatus(record.status),
    blocks,
    blockedBy: publicDependencies(taskListId, record.blocked_by),
    files_touched: record.files_touched,
    read_set: record.read_set,
    write_set: record.write_set,
    started_at: record.started_at,
    finished_at: record.finished_at,
    policy_epoch: record.policy_epoch,
    policy_digest: record.policy_digest,
    report_id: record.report_id,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function graphInputFromTask(
  taskListId: string,
  task: BridgeCreateInput,
): RouteTaskInput {
  if (!task.id) throw new Error("Task graph input requires a public ID");
  const metadata = task.metadata ?? {};
  const structural = structuralMetadata(task.metadata);
  const requestedStatus = graphStatus(task.status);
  const metadataKind = metadata.kind;
  const metadataEffort = metadata.effort;
  const metadataPriority = metadata.priority;
  const metadataPolicyEpoch = metadata.policy_epoch;
  const metadataPolicyDigest = metadata.policy_digest;
  const metadataReportId = metadata.report_id;
  const kind =
    task.kind ??
    (typeof metadataKind === "string" ? (metadataKind as TaskKind) : undefined);
  const effort =
    task.effort ??
    (typeof metadataEffort === "string"
      ? (metadataEffort as TaskEffort)
      : undefined);
  const priority =
    task.priority ??
    (typeof metadataPriority === "number" ? metadataPriority : undefined);
  return {
    id: storageTaskId(taskListId, task.id),
    status:
      requestedStatus === "claimed" || requestedStatus === "running"
        ? "pending"
        : requestedStatus,
    owner: null,
    kind,
    effort,
    priority,
    blocked_by: namespaceDependencies(taskListId, task.blockedBy),
    files_touched: namespaceTargets(
      taskListId,
      task.files_touched ?? structural.files_touched,
      "files_touched",
    ),
    read_set: namespaceTargets(
      taskListId,
      task.read_set ?? structural.read_set,
      "read_set",
    ),
    write_set: namespaceTargets(
      taskListId,
      task.write_set ?? structural.write_set,
      "write_set",
    ),
    isolation: structural.isolation,
    started_at: task.started_at ?? null,
    finished_at: task.finished_at ?? null,
    policy_epoch:
      task.policy_epoch ??
      (typeof metadataPolicyEpoch === "number"
        ? metadataPolicyEpoch
        : undefined),
    policy_digest:
      task.policy_digest !== undefined
        ? task.policy_digest
        : typeof metadataPolicyDigest === "string"
          ? metadataPolicyDigest
          : metadataPolicyDigest === null
            ? null
            : undefined,
    report_id:
      task.report_id ??
      (typeof metadataReportId === "string" ? metadataReportId : undefined),
  };
}

function mergeMetadataPreserving(
  existingValue: string | undefined,
  rawValue: string,
): string {
  const existing = parseMetadata(existingValue);
  const raw = parseMetadata(rawValue);
  const conflicts: TaskMetadata = {};
  for (const [key, value] of Object.entries(raw)) {
    if (
      key in existing &&
      JSON.stringify(existing[key]) !== JSON.stringify(value)
    ) {
      conflicts[key] = existing[key];
    }
  }
  const merged = { ...existing, ...raw };
  if (Object.keys(conflicts).length > 0) {
    merged._namespace_migration_previous = conflicts;
  }
  return JSON.stringify(merged);
}

function migrateRawBridgeRows(db: Database): void {
  const rawDetails = db
    .prepare("SELECT * FROM task_graph_details WHERE task_id NOT LIKE ?")
    .all(`${STORAGE_PREFIX}%`) as DetailRow[];
  if (rawDetails.length === 0) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    const mappings = new Map(
      rawDetails.map((detail) => [
        detail.task_id,
        {
          oldId: detail.task_id,
          newId: storageTaskId(detail.task_list_id, detail.public_id),
          taskListId: detail.task_list_id,
          publicId: detail.public_id,
          detail,
        },
      ]),
    );

    for (const mapping of mappings.values()) {
      const oldTask = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(mapping.oldId) as StoredTaskRow | undefined;
      const existingTask = db
        .prepare("SELECT * FROM tasks WHERE id = ?")
        .get(mapping.newId) as StoredTaskRow | undefined;

      if (oldTask && !existingTask) {
        const blockedBy = parseStringArray(oldTask.blocked_by).map(
          (dependency) => {
            const mapped = mappings.get(dependency);
            return mapped?.taskListId === mapping.taskListId
              ? mapped.newId
              : publicTaskId(mapping.taskListId, dependency) === null
                ? storageTaskId(mapping.taskListId, dependency)
                : dependency;
          },
        );
        db.prepare(`
          INSERT INTO tasks(
            id, status, owner, kind, effort, priority, blocked_by, claimed_at,
            started_at, finished_at, files_touched, read_set, write_set,
            isolation, sets_explicit, lease_id, version, policy_epoch,
            policy_digest, report_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mapping.newId,
          oldTask.status,
          oldTask.owner,
          oldTask.kind || "implement",
          oldTask.effort || "medium",
          oldTask.priority ?? 0,
          JSON.stringify(blockedBy),
          oldTask.claimed_at,
          oldTask.started_at ?? null,
          oldTask.finished_at ?? null,
          JSON.stringify(
            parseStringArray(oldTask.files_touched).map((target) =>
              namespaceTarget(mapping.taskListId, target),
            ),
          ),
          JSON.stringify(
            parseStringArray(oldTask.read_set).map((target) =>
              namespaceTarget(mapping.taskListId, target),
            ),
          ),
          JSON.stringify(
            parseStringArray(oldTask.write_set).map((target) =>
              namespaceTarget(mapping.taskListId, target),
            ),
          ),
          oldTask.isolation,
          oldTask.sets_explicit,
          oldTask.lease_id,
          oldTask.version,
          oldTask.policy_epoch,
          oldTask.policy_digest ?? null,
          oldTask.report_id ?? null,
        );
        db.prepare("UPDATE task_leases SET task_id = ? WHERE task_id = ?").run(
          mapping.newId,
          mapping.oldId,
        );
        db.prepare(
          "UPDATE task_idempotency SET task_id = ? WHERE task_id = ?",
        ).run(mapping.newId, mapping.oldId);
        db.prepare("DELETE FROM tasks WHERE id = ?").run(mapping.oldId);
      }

      const existingDetail = db
        .prepare("SELECT * FROM task_graph_details WHERE task_id = ?")
        .get(mapping.newId) as DetailRow | undefined;
      const metadata = mergeMetadataPreserving(
        existingDetail?.metadata,
        mapping.detail.metadata,
      );
      if (existingDetail) {
        db.prepare(`
          UPDATE task_graph_details
          SET task_list_id = ?, public_id = ?, subject = ?, description = ?,
              active_form = ?, metadata = ?, deleted = ?
          WHERE task_id = ?
        `).run(
          mapping.taskListId,
          mapping.publicId,
          mapping.detail.subject,
          mapping.detail.description,
          mapping.detail.active_form,
          metadata,
          mapping.detail.deleted,
          mapping.newId,
        );
        db.prepare("DELETE FROM task_graph_details WHERE task_id = ?").run(
          mapping.oldId,
        );
      } else {
        db.prepare(`
          UPDATE task_graph_details
          SET task_id = ?, public_id = ?, metadata = ?
          WHERE task_id = ?
        `).run(mapping.newId, mapping.publicId, metadata, mapping.oldId);
      }
    }

    db.prepare(`
      UPDATE task_graph_meta
      SET value = CAST(value AS INTEGER) + 1
      WHERE key = 'graph_version'
    `).run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

async function migrateLegacyTasks(
  graph: TaskGraph,
  db: Database,
  taskListId: string,
): Promise<void> {
  const marker = `legacy-v2:${taskListId}`;
  if (
    db.prepare("SELECT 1 FROM task_graph_bridge_meta WHERE key = ?").get(marker)
  ) {
    return;
  }

  let files: string[] = [];
  try {
    files = await readdir(legacyTasksDir(taskListId));
  } catch {
    db.prepare(
      "INSERT OR IGNORE INTO task_graph_bridge_meta(key, value) VALUES (?, ?)",
    ).run(marker, "done");
    return;
  }

  const legacy: LegacyTask[] = [];
  for (const file of files.filter(
    (name) => name.endsWith(".json") && !name.startsWith("."),
  )) {
    try {
      const value = JSON.parse(
        await readFile(join(legacyTasksDir(taskListId), file), "utf8"),
      ) as LegacyTask;
      if (
        value &&
        typeof value.id === "string" &&
        typeof value.subject === "string"
      ) {
        legacy.push(value);
      }
    } catch {
      // Malformed legacy entries never override the SQLite source.
    }
  }

  const ids = new Set(legacy.map((task) => task.id));
  const reverseBlocks = new Map<string, string[]>();
  for (const task of legacy) {
    for (const target of task.blocks ?? []) {
      if (ids.has(target)) {
        reverseBlocks.set(target, [
          ...(reverseBlocks.get(target) ?? []),
          task.id,
        ]);
      }
    }
  }

  for (const task of legacy) {
    const storedId = storageTaskId(taskListId, task.id);
    const existingDetail = readDetail(db, taskListId, task.id);
    const importedStatus =
      task.status === "completed" || task.status === "failed"
        ? graphStatus(task.status)
        : "pending";
    const input: BridgeCreateInput = {
      id: task.id,
      subject: task.subject,
      description: task.description ?? "",
      activeForm: task.activeForm,
      status: importedStatus,
      blocks: [],
      blockedBy: [],
      metadata: asMetadata(task.metadata),
    };
    if (graph.read(storedId) === null) {
      try {
        graph.route(graphInputFromTask(taskListId, input));
      } catch (error) {
        if (!(error instanceof DuplicateTaskError)) continue;
      }
    }
    if (!existingDetail) writeDetail(db, taskListId, input);
  }

  for (const task of legacy) {
    const storedId = storageTaskId(taskListId, task.id);
    const current = graph.read(storedId);
    if (!current) continue;
    const blockedBy = [
      ...new Set([
        ...(task.blockedBy ?? []),
        ...(reverseBlocks.get(task.id) ?? []),
      ]),
    ].filter((id) => ids.has(id) && id !== task.id);
    try {
      graph.routeUpdate(
        storedId,
        { blocked_by: namespaceDependencies(taskListId, blockedBy) },
        { expectedVersion: current.version },
      );
    } catch {
      // A concurrent graph writer owns the latest state.
    }
  }

  db.prepare(
    "INSERT OR IGNORE INTO task_graph_bridge_meta(key, value) VALUES (?, ?)",
  ).run(marker, "done");
}

function metadataWithStructural(
  metadata: TaskMetadata,
  patch: BridgeTaskPatch,
): TaskMetadata {
  const merged = { ...metadata };
  if (patch.files_touched !== undefined) {
    merged.files_touched = [...patch.files_touched];
  }
  if (patch.read_set !== undefined) merged.read_set = [...patch.read_set];
  if (patch.write_set !== undefined) merged.write_set = [...patch.write_set];
  if (patch.isolation !== undefined) merged.isolation = patch.isolation;
  return merged;
}

function mapClaimFailure(
  taskListId: string,
  result: ClaimFailure,
  task: BridgeTask | null,
): Extract<BridgeClaimResult, { success: false }> {
  let reason:
    | "task_not_found"
    | "already_claimed"
    | "already_resolved"
    | "blocked" = "already_claimed";
  if (result.reason === "not_found") reason = "task_not_found";
  else if (result.reason === "dependencies_incomplete") reason = "blocked";
  else if (result.reason === "status_not_pending") {
    reason =
      result.task?.status === "completed" || result.task?.status === "failed"
        ? "already_resolved"
        : "already_claimed";
  }
  return {
    success: false,
    reason,
    task: task ?? undefined,
    blockedByTasks: publicDependencies(taskListId, result.blocked_by),
  };
}

type AdapterFallbackGraph = () => Promise<TaskGraph>;

/**
 * The adapter keeps the UI/detail store local, but delegates the authoritative
 * task graph to the native daemon.  The local TaskGraph is opened lazily and
 * only through a daemon-availability fallback callback.
 */
class DaemonBackedTaskGraph {
  private authority: "daemon" | "fallback" | undefined;

  constructor(
    private readonly client: TaskGraphDaemonClient,
    private readonly fallbackGraph: AdapterFallbackGraph,
  ) {}

  private async call<T>(
    firstDaemon: () => Promise<DaemonCallResult<T>>,
    daemon: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<DaemonCallResult<T>> {
    if (this.authority === "fallback") {
      return {
        source: "fallback",
        value: await fallback(),
        reason: "unavailable",
      };
    }
    if (this.authority === "daemon") {
      return { source: "daemon", value: await daemon() };
    }
    const result = await firstDaemon();
    this.authority = result.source;
    return result;
  }

  route(
    task: RouteTaskInput,
    mode: "block" | "reject" = "block",
  ): Promise<DaemonCallResult<import("../tasks/graph/types.js").RouteResult>> {
    return this.call(
      () =>
        this.client.routeWithFallback(
          task,
          async () => (await this.getFallbackGraph()).route(task, { mode }),
          mode,
        ),
      () => this.client.route(task, mode),
      async () => (await this.getFallbackGraph()).route(task, { mode }),
    );
  }

  read(taskId: string): Promise<DaemonCallResult<{ task: TaskRecord | null }>> {
    return this.call(
      () =>
        this.client.readWithFallback(taskId, async () => ({
          task: (await this.getFallbackGraph()).read(taskId),
        })),
      () => this.client.read(taskId),
      async () => ({ task: (await this.getFallbackGraph()).read(taskId) }),
    );
  }

  list(
    params: TaskGraphListParams = {},
  ): Promise<DaemonCallResult<{ tasks: TaskRecord[] }>> {
    return this.call(
      () =>
        this.client.listWithFallback(params, async () => ({
          tasks: (await this.getFallbackGraph()).list(params),
        })),
      () => this.client.list(params),
      async () => ({ tasks: (await this.getFallbackGraph()).list(params) }),
    );
  }

  listDependents(
    taskId: string,
  ): Promise<DaemonCallResult<{ tasks: TaskRecord[] }>> {
    return this.call(
      () =>
        this.client.listDependentsWithFallback(taskId, async () => ({
          tasks: (await this.getFallbackGraph()).listDependents(taskId),
        })),
      () => this.client.listDependents(taskId),
      async () => ({
        tasks: (await this.getFallbackGraph()).listDependents(taskId),
      }),
    );
  }

  claim(
    request: import("../runtime/taskGraph/protocol.js").TaskGraphClaimParams,
  ): Promise<DaemonCallResult<ClaimResult>> {
    return this.call(
      () =>
        this.client.claimWithFallback(request, async () =>
          (await this.getFallbackGraph()).tryClaim(
            request.task_id,
            request.owner,
            request,
          ),
        ),
      () => this.client.claim(request),
      async () =>
        (await this.getFallbackGraph()).tryClaim(
          request.task_id,
          request.owner,
          request,
        ),
    );
  }

  update(
    taskId: string,
    patch: import("../tasks/graph/types.js").TaskUpdate,
    expectedVersion: number | undefined,
  ): Promise<DaemonCallResult<{ task: TaskRecord }>> {
    return this.call(
      () =>
        this.client.updateWithFallback(
          taskId,
          patch,
          async () => ({
            task: (await this.getFallbackGraph()).update(
              taskId,
              patch,
              expectedVersion,
            ),
          }),
          expectedVersion,
        ),
      () => this.client.update(taskId, patch, expectedVersion),
      async () => ({
        task: (await this.getFallbackGraph()).update(
          taskId,
          patch,
          expectedVersion,
        ),
      }),
    );
  }

  routeUpdate(
    taskId: string,
    patch: import("../tasks/graph/types.js").TaskUpdate,
    expectedVersion: number,
    mode: "block" | "reject" = "block",
  ): Promise<DaemonCallResult<import("../tasks/graph/types.js").RouteResult>> {
    const params = {
      task_id: taskId,
      patch,
      expected_version: expectedVersion,
      mode,
    };
    return this.call(
      () =>
        this.client.routeUpdateWithFallback(params, async () =>
          (await this.getFallbackGraph()).routeUpdate(taskId, patch, {
            expectedVersion,
            mode,
          }),
        ),
      () => this.client.routeUpdate(params),
      async () =>
        (await this.getFallbackGraph()).routeUpdate(taskId, patch, {
          expectedVersion,
          mode,
        }),
    );
  }

  async close(): Promise<void> {
    // The daemon owns its process/database.  Only the lazy fallback graph is
    // local to this adapter operation and must be closed here.
    if (this.fallbackGraphValue) {
      this.fallbackGraphValue.close();
      this.fallbackGraphValue = undefined;
    }
  }

  private fallbackGraphValue?: TaskGraph;

  async getFallbackGraph(): Promise<TaskGraph> {
    if (!this.fallbackGraphValue)
      this.fallbackGraphValue = await this.fallbackGraph();
    return this.fallbackGraphValue;
  }
}

let daemonClientFactory: () => TaskGraphDaemonClient = () =>
  new TaskGraphDaemonClient();

async function migrateLegacyTasksToDaemon(
  graph: DaemonBackedTaskGraph,
  db: Database,
  taskListId: string,
): Promise<void> {
  const marker = `legacy-v2:${taskListId}`;
  if (
    db.prepare("SELECT 1 FROM task_graph_bridge_meta WHERE key = ?").get(marker)
  )
    return;

  let files: string[] = [];
  try {
    files = await readdir(legacyTasksDir(taskListId));
  } catch {
    db.prepare(
      "INSERT OR IGNORE INTO task_graph_bridge_meta(key, value) VALUES (?, ?)",
    ).run(marker, "done");
    return;
  }

  const legacy: LegacyTask[] = [];
  for (const file of files.filter(
    (name) => name.endsWith(".json") && !name.startsWith("."),
  )) {
    try {
      const value = JSON.parse(
        await readFile(join(legacyTasksDir(taskListId), file), "utf8"),
      ) as LegacyTask;
      if (
        value &&
        typeof value.id === "string" &&
        typeof value.subject === "string"
      )
        legacy.push(value);
    } catch {
      // Ignore malformed compatibility files; the daemon graph remains authoritative.
    }
  }
  const ids = new Set(legacy.map((task) => task.id));
  const reverseBlocks = new Map<string, string[]>();
  for (const task of legacy) {
    for (const target of task.blocks ?? []) {
      if (ids.has(target))
        reverseBlocks.set(target, [
          ...(reverseBlocks.get(target) ?? []),
          task.id,
        ]);
    }
  }

  for (const task of legacy) {
    const importedStatus =
      task.status === "completed" || task.status === "failed"
        ? graphStatus(task.status)
        : "pending";
    const input: BridgeCreateInput = {
      id: task.id,
      subject: task.subject,
      description: task.description ?? "",
      activeForm: task.activeForm,
      status: importedStatus,
      blocks: [],
      blockedBy: [],
      metadata: asMetadata(task.metadata),
    };
    const storedId = storageTaskId(taskListId, task.id);
    const existing = resultValue(await graph.read(storedId));
    if (!existing.task) {
      const routed = resultValue(
        await graph.route(graphInputFromTask(taskListId, input)),
      );
      if (!routed.task) continue;
    }
    if (!readDetail(db, taskListId, task.id))
      writeDetail(db, taskListId, input);
  }

  for (const task of legacy) {
    const storedId = storageTaskId(taskListId, task.id);
    const current = resultValue(await graph.read(storedId)).task;
    if (!current) continue;
    const blockedBy = [
      ...new Set([
        ...(task.blockedBy ?? []),
        ...(reverseBlocks.get(task.id) ?? []),
      ]),
    ].filter((id) => ids.has(id) && id !== task.id);
    if (blockedBy.length === 0) continue;
    try {
      const routed = resultValue(
        await graph.routeUpdate(
          storedId,
          { blocked_by: namespaceDependencies(taskListId, blockedBy) },
          current.version,
        ),
      );
      if (!routed.task || !routed.decision.allowed) {
        throw new Error(`Legacy task dependency route was rejected: ${storedId}`);
      }
    } catch (error) {
      if (!isBenignMigrationVersionConflict(error)) throw error;
      const latest = resultValue(await graph.read(storedId)).task;
      const expectedDependencies =
        namespaceDependencies(taskListId, blockedBy) ?? [];
      if (
        !latest ||
        expectedDependencies.some(
          (dependency) => !latest.blocked_by.includes(dependency),
        )
      ) {
        throw error;
      }
    }
  }

  db.prepare(
    "INSERT OR IGNORE INTO task_graph_bridge_meta(key, value) VALUES (?, ?)",
  ).run(marker, "done");
}

function isBenignMigrationVersionConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "VERSION_CONFLICT"
  );
}

/** Test-only dependency injection; production always uses the daemon manager. */
export function setTaskGraphDaemonClientForTests(
  factory: (() => TaskGraphDaemonClient) | undefined,
): void {
  daemonClientFactory = factory ?? (() => new TaskGraphDaemonClient());
}

async function withAdapterStores<T>(
  taskListId: string,
  fn: (graph: DaemonBackedTaskGraph, db: Database) => Promise<T>,
): Promise<T> {
  const db = openDetailsDb();
  let migration: Promise<TaskGraph> | undefined;
  const fallbackGraph = async (): Promise<TaskGraph> => {
    if (!migration) {
      migration = (async () => {
        const opened = openTaskGraph();
        try {
          migrateRawBridgeRows(db);
          await migrateLegacyTasks(opened, db, taskListId);
          return opened;
        } catch (error) {
          try {
            opened.close();
          } catch {
            // Preserve the migration failure as the authoritative error.
          }
          throw error;
        }
      })();
    }
    return migration;
  };
  const graph = new DaemonBackedTaskGraph(daemonClientFactory(), fallbackGraph);
  try {
    await migrateLegacyTasksToDaemon(graph, db, taskListId);
    return await fn(graph, db);
  } finally {
    await graph.close();
    db.close();
  }
}

function resultValue<T>(result: DaemonCallResult<T>): T {
  return result.value;
}

function duplicateTaskError(error: unknown): boolean {
  return (
    error instanceof DuplicateTaskError ||
    (typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "DUPLICATE_TASK")
  );
}

async function allTasksFromBackend(
  graph: DaemonBackedTaskGraph,
  db: Database,
  taskListId: string,
): Promise<BridgeTask[]> {
  const details = readDetailsForList(db, taskListId);
  const records = resultValue(await graph.list());
  return records.tasks
    .filter((record) => {
      const detail = details.get(record.id);
      return (
        record.id.startsWith(taskNamespacePrefix(taskListId)) &&
        detail?.task_list_id === taskListId &&
        detail.public_id === publicTaskId(taskListId, record.id)
      );
    })
    .map((record) =>
      normalizeGraphRecord(
        taskListId,
        record,
        details.get(record.id),
        records.tasks,
      ),
    )
    .filter((task): task is BridgeTask => task !== null);
}

async function oneTaskFromBackend(
  graph: DaemonBackedTaskGraph,
  db: Database,
  taskListId: string,
  publicId: string,
): Promise<BridgeTask | null> {
  const storedId = storageTaskId(taskListId, publicId);
  const record = resultValue(await graph.read(storedId));
  const detail = readDetail(db, taskListId, publicId);
  if (!record.task) return null;
  const dependents = resultValue(await graph.listDependents(storedId));
  return normalizeGraphRecord(
    taskListId,
    record.task,
    detail,
    dependents.tasks,
  );
}

export async function graphCreateTask(
  taskListId: string,
  input: BridgeCreateInput,
): Promise<string> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const autoId = input.id === undefined;
    let nextId = 1;
    if (autoId) {
      for (const record of resultValue(await graph.list()).tasks) {
        const publicId = publicTaskId(taskListId, record.id);
        if (publicId && /^\d+$/.test(publicId))
          nextId = Math.max(nextId, Number(publicId) + 1);
      }
    }
    for (;;) {
      const publicId = autoId ? String(nextId) : input.id;
      if (!publicId) throw new Error("Task ID must be non-empty");
      const task = { ...input, id: publicId };
      try {
        const routed = resultValue(
          await graph.route(graphInputFromTask(taskListId, task)),
        );
        if (!routed.task)
          throw new Error(
            `Task ${publicId} was rejected by overlap validation`,
          );
        writeDetail(db, taskListId, task);
        return publicId;
      } catch (error) {
        if (!autoId || !duplicateTaskError(error)) throw error;
        nextId += 1;
      }
    }
  });
}

export async function graphGetTask(
  taskListId: string,
  taskId: string,
): Promise<BridgeTask | null> {
  return withAdapterStores(taskListId, (graph, db) =>
    oneTaskFromBackend(graph, db, taskListId, taskId),
  );
}

export async function graphListTasks(
  taskListId: string,
): Promise<BridgeTask[]> {
  return withAdapterStores(taskListId, (graph, db) =>
    allTasksFromBackend(graph, db, taskListId),
  );
}

/** Read the authoritative global graph without exposing a second storage path. */
export async function graphSnapshot(): Promise<TaskGraphSnapshot> {
  const result = await daemonClientFactory().snapshotWithFallback(() => {
    const graph = openTaskGraph();
    try {
      return graph.snapshot();
    } finally {
      graph.close();
    }
  });
  return result.value;
}

export async function graphUpdateTask(
  taskListId: string,
  taskId: string,
  patch: BridgeTaskPatch,
): Promise<BridgeTask | null> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const beforeResult = await graph.read(storedId);
    const before = resultValue(beforeResult).task;
    const detail = readDetail(db, taskListId, taskId);
    if (!before || !detail) return null;
    const dependents = resultValue(await graph.listDependents(storedId)).tasks;
    const current = normalizeGraphRecord(
      taskListId,
      before,
      detail,
      dependents,
    );
    if (!current) return null;
    const mergedMetadata =
      patch.metadata === undefined
        ? parseMetadata(detail.metadata)
        : { ...parseMetadata(detail.metadata), ...patch.metadata };
    const effectiveMetadata = metadataWithStructural(mergedMetadata, patch);
    const structural = structuralMetadata(effectiveMetadata);
    const effectiveKind =
      patch.kind ??
      (typeof effectiveMetadata.kind === "string"
        ? (effectiveMetadata.kind as TaskKind)
        : undefined);
    const effectiveEffort =
      patch.effort ??
      (typeof effectiveMetadata.effort === "string"
        ? (effectiveMetadata.effort as TaskEffort)
        : undefined);
    const effectivePriority =
      patch.priority ??
      (typeof effectiveMetadata.priority === "number"
        ? effectiveMetadata.priority
        : undefined);
    const effectivePolicyEpoch =
      patch.policy_epoch ??
      (typeof effectiveMetadata.policy_epoch === "number"
        ? effectiveMetadata.policy_epoch
        : undefined);
    const effectivePolicyDigest =
      patch.policy_digest !== undefined
        ? patch.policy_digest
        : typeof effectiveMetadata.policy_digest === "string"
          ? effectiveMetadata.policy_digest
          : undefined;
    const effectiveReportId =
      patch.report_id !== undefined
        ? patch.report_id
        : typeof effectiveMetadata.report_id === "string"
          ? effectiveMetadata.report_id
          : undefined;
    const requestedStatus =
      patch.status === "in_progress" ? "running" : patch.status;
    const ownerWasProvided = patch.owner !== undefined;
    const requestedOwner =
      patch.owner === undefined ? before.owner : patch.owner;

    if (
      ownerWasProvided &&
      requestedOwner !== before.owner &&
      (before.status === "claimed" || before.status === "running")
    ) {
      throw new Error(
        `Task ${taskId} has an active lease and cannot change owner`,
      );
    }

    const wantsLeaseStatus =
      requestedStatus === "claimed" || requestedStatus === "running";
    const claimsPendingOwner =
      before.status === "pending" &&
      ownerWasProvided &&
      requestedOwner !== before.owner &&
      requestedOwner !== null &&
      (requestedStatus === undefined || requestedStatus === "pending");
    const claimsPendingLifecycle = before.status === "pending" && wantsLeaseStatus;
    const shouldClaim = claimsPendingOwner || claimsPendingLifecycle;

    // Structural fields are routed while the task is still pending. This
    // gives route_update the exclusive overlap/CAS decision before claim/run.
    // The status transition is deliberately applied only after the claim.
    const graphPatch: import("../tasks/graph/types.js").TaskUpdate = {
      ...(shouldClaim || requestedStatus === undefined
        ? {}
        : { status: requestedStatus as GraphTaskStatus }),
      ...(effectiveKind === undefined ? {} : { kind: effectiveKind }),
      ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
      ...(effectivePriority === undefined
        ? {}
        : { priority: effectivePriority }),
      ...(ownerWasProvided &&
      (shouldClaim ||
        requestedStatus === undefined ||
        requestedStatus === "pending" ||
        requestedStatus === "completed" ||
        requestedStatus === "failed")
        ? { owner: requestedOwner }
        : {}),
      ...(patch.blockedBy === undefined
        ? {}
        : { blocked_by: namespaceDependencies(taskListId, patch.blockedBy) }),
      ...(structural.files_touched === undefined
        ? {}
        : {
            files_touched: namespaceTargets(
              taskListId,
              structural.files_touched,
              "files_touched",
            ),
          }),
      ...(structural.read_set === undefined
        ? {}
        : {
            read_set: namespaceTargets(
              taskListId,
              structural.read_set,
              "read_set",
            ),
          }),
      ...(structural.write_set === undefined
        ? {}
        : {
            write_set: namespaceTargets(
              taskListId,
              structural.write_set,
              "write_set",
            ),
          }),
      ...(structural.isolation === undefined
        ? {}
        : { isolation: structural.isolation }),
      ...(patch.started_at === undefined
        ? {}
        : { started_at: patch.started_at }),
      ...(patch.finished_at === undefined
        ? {}
        : { finished_at: patch.finished_at }),
      ...(effectivePolicyEpoch === undefined
        ? {}
        : { policy_epoch: effectivePolicyEpoch }),
      ...(effectivePolicyDigest === undefined
        ? {}
        : { policy_digest: effectivePolicyDigest }),
      ...(effectiveReportId === undefined
        ? {}
        : { report_id: effectiveReportId }),
    };

    let record = before;
    if (Object.keys(graphPatch).length > 0) {
      const needsOverlapValidation =
        shouldClaim ||
        patch.blockedBy !== undefined ||
        structural.files_touched !== undefined ||
        structural.read_set !== undefined ||
        structural.write_set !== undefined ||
        structural.isolation !== undefined;
      if (needsOverlapValidation) {
        const routed = resultValue(
          await graph.routeUpdate(storedId, graphPatch, before.version),
        );
        if (!routed.task || !routed.decision.allowed) {
          throw new Error(`Task ${taskId} was rejected by overlap validation`);
        }
        record = routed.task;
      } else {
        record = resultValue(
          await graph.update(storedId, graphPatch, before.version),
        ).task;
      }
    }

    if (shouldClaim) {
      const claimResult = resultValue(
        await graph.claim({
          task_id: storedId,
          owner: requestedOwner ?? "task-agent",
          expected_version: record.version,
        }),
      );
      if (!claimResult.ok)
        throw new Error(
          `Task ${taskId} cannot be claimed: ${claimResult.reason}`,
        );
      record = claimResult.task;
      if (requestedStatus === "running") {
        record = resultValue(
          await graph.update(storedId, { status: "running" }, record.version),
        ).task;
      }
    }
    patchDetail(db, taskListId, taskId, detail, patch, effectiveMetadata);
    return normalizeGraphRecord(
      taskListId,
      record,
      readDetail(db, taskListId, taskId),
      resultValue(await graph.listDependents(storedId)).tasks,
    );
  });
}

export async function graphDeleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const current = resultValue(await graph.read(storedId)).task;
    const detail = readDetail(db, taskListId, taskId);
    if (!current || !detail) return false;
    if (current.status !== "completed" && current.status !== "failed") {
      await graph.update(storedId, { status: "completed" }, current.version);
    }
    db.prepare(
      "UPDATE task_graph_details SET deleted = 1 WHERE task_id = ?",
    ).run(storedId);
    return true;
  });
}

export async function graphBlockTask(
  taskListId: string,
  fromTaskId: string,
  toTaskId: string,
): Promise<boolean> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const fromStoredId = storageTaskId(taskListId, fromTaskId);
    const toStoredId = storageTaskId(taskListId, toTaskId);
    const from = resultValue(await graph.read(fromStoredId)).task;
    const to = resultValue(await graph.read(toStoredId)).task;
    if (
      !from ||
      !to ||
      !readDetail(db, taskListId, fromTaskId) ||
      !readDetail(db, taskListId, toTaskId)
    )
      return false;
    if (!to.blocked_by.includes(fromStoredId)) {
      await graph.update(
        toStoredId,
        { blocked_by: [...to.blocked_by, fromStoredId] },
        to.version,
      );
    }
    return true;
  });
}

export async function graphClaimTask(
  taskListId: string,
  taskId: string,
  owner: string,
  checkAgentBusy = false,
): Promise<BridgeClaimResult> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const candidateRecord = resultValue(await graph.read(storedId)).task;
    const detail = readDetail(db, taskListId, taskId);
    const candidate = candidateRecord
      ? normalizeGraphRecord(
          taskListId,
          candidateRecord,
          detail,
          resultValue(await graph.listDependents(storedId)).tasks,
        )
      : null;
    if (!candidate) return { success: false, reason: "task_not_found" };
    if (checkAgentBusy) {
      const busy = resultValue(await graph.list({ owner })).tasks.filter(
        (task) =>
          task.id.startsWith(taskNamespacePrefix(taskListId)) &&
          task.owner === owner &&
          task.id !== storedId &&
          !["completed", "failed"].includes(task.status),
      );
      if (busy.length > 0)
        return {
          success: false,
          reason: "agent_busy",
          busyWithTasks: busy
            .map((task) => publicTaskId(taskListId, task.id))
            .filter((id): id is string => id !== null),
        };
    }
    const result = resultValue(await graph.claim({ task_id: storedId, owner }));
    if (!result.ok)
      return mapClaimFailure(
        taskListId,
        result,
        result.task
          ? normalizeGraphRecord(
              taskListId,
              result.task,
              detail,
              resultValue(await graph.listDependents(storedId)).tasks,
            )
          : candidate,
      );
    const task = normalizeGraphRecord(
      taskListId,
      result.task,
      detail,
      resultValue(await graph.listDependents(storedId)).tasks,
    );
    if (!task) throw new Error(`Task ${taskId} was deleted during claim`);
    return { success: true, task };
  });
}

export async function graphResetTaskList(taskListId: string): Promise<void> {
  return withAdapterStores(taskListId, async (graph, db) => {
    const details = readDetailsForList(db, taskListId);
    const records = resultValue(await graph.list()).tasks.filter(
      (task) =>
        task.id.startsWith(taskNamespacePrefix(taskListId)) &&
        details.has(task.id),
    );
    for (const task of records) {
      if (task.status !== "completed" && task.status !== "failed") {
        try {
          await graph.update(task.id, { status: "completed" }, task.version);
        } catch {
          /* concurrent writer owns latest state */
        }
      }
    }
    db.prepare(
      "UPDATE task_graph_details SET deleted = 1 WHERE task_list_id = ?",
    ).run(taskListId);
  });
}
