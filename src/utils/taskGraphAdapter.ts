import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { getTaskGraphPaths } from "../storage/taskGraphPaths.js";
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

function recordsForList(
  graph: TaskGraph,
  details: Map<string, DetailRow>,
  taskListId: string,
): TaskRecord[] {
  const prefix = taskNamespacePrefix(taskListId);
  return graph.list().filter((record) => {
    const detail = details.get(record.id);
    return (
      record.id.startsWith(prefix) &&
      detail?.task_list_id === taskListId &&
      detail.public_id === publicTaskId(taskListId, record.id)
    );
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
    report_id:
      task.report_id ??
      (typeof metadataReportId === "string" ? metadataReportId : undefined),
  };
}

function taskIdForNextNumeric(graph: TaskGraph, taskListId: string): number {
  let max = 0;
  for (const record of graph.list()) {
    const publicId = publicTaskId(taskListId, record.id);
    if (publicId && /^\d+$/.test(publicId))
      max = Math.max(max, Number(publicId));
  }
  return max + 1;
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
            isolation, sets_explicit, lease_id, version, policy_epoch, report_id
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

async function withStores<T>(
  taskListId: string,
  fn: (graph: TaskGraph, db: Database) => Promise<T> | T,
): Promise<T> {
  const graph = openTaskGraph();
  const db = openDetailsDb();
  try {
    migrateRawBridgeRows(db);
    await migrateLegacyTasks(graph, db, taskListId);
    return await fn(graph, db);
  } finally {
    db.close();
    graph.close();
  }
}

function allTasks(
  graph: TaskGraph,
  db: Database,
  taskListId: string,
): BridgeTask[] {
  const details = readDetailsForList(db, taskListId);
  const records = recordsForList(graph, details, taskListId);
  return records
    .map((record) =>
      normalizeGraphRecord(taskListId, record, details.get(record.id), records),
    )
    .filter((task): task is BridgeTask => task !== null);
}

function oneTask(
  graph: TaskGraph,
  db: Database,
  taskListId: string,
  publicId: string,
): BridgeTask | null {
  const storedId = storageTaskId(taskListId, publicId);
  const record = graph.read(storedId);
  const detail = readDetail(db, taskListId, publicId);
  return record
    ? normalizeGraphRecord(
        taskListId,
        record,
        detail,
        graph.listDependents(storedId),
      )
    : null;
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

export async function graphCreateTask(
  taskListId: string,
  input: BridgeCreateInput,
): Promise<string> {
  return withStores(taskListId, (graph, db) => {
    const autoId = input.id === undefined;
    let nextId = autoId ? taskIdForNextNumeric(graph, taskListId) : 0;
    for (;;) {
      const publicId = autoId ? String(nextId) : input.id;
      if (!publicId) throw new Error("Task ID must be non-empty");
      const task = { ...input, id: publicId };
      try {
        const routed = graph.route(graphInputFromTask(taskListId, task));
        if (!routed.task) {
          throw new Error(
            `Task ${publicId} was rejected by overlap validation`,
          );
        }
        writeDetail(db, taskListId, task);
        return publicId;
      } catch (error) {
        if (!autoId || !(error instanceof DuplicateTaskError)) throw error;
        nextId += 1;
      }
    }
  });
}

export async function graphGetTask(
  taskListId: string,
  taskId: string,
): Promise<BridgeTask | null> {
  return withStores(taskListId, (graph, db) =>
    oneTask(graph, db, taskListId, taskId),
  );
}

export async function graphListTasks(
  taskListId: string,
): Promise<BridgeTask[]> {
  return withStores(taskListId, (graph, db) => allTasks(graph, db, taskListId));
}

export async function graphUpdateTask(
  taskListId: string,
  taskId: string,
  patch: BridgeTaskPatch,
): Promise<BridgeTask | null> {
  return withStores(taskListId, (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const before = graph.read(storedId);
    const detail = readDetail(db, taskListId, taskId);
    const current = before
      ? normalizeGraphRecord(
          taskListId,
          before,
          detail,
          graph.listDependents(storedId),
        )
      : null;
    if (!before || !current) return null;
    const mergedMetadata =
      patch.metadata === undefined
        ? parseMetadata(detail?.metadata)
        : { ...parseMetadata(detail?.metadata), ...patch.metadata };
    const effectiveMetadata = metadataWithStructural(mergedMetadata, patch);
    const structural = structuralMetadata(effectiveMetadata);
    const metadataKind = effectiveMetadata.kind;
    const metadataEffort = effectiveMetadata.effort;
    const metadataPriority = effectiveMetadata.priority;
    const metadataPolicyEpoch = effectiveMetadata.policy_epoch;
    const metadataReportId = effectiveMetadata.report_id;
    const effectiveKind =
      patch.kind ??
      (typeof metadataKind === "string"
        ? (metadataKind as TaskKind)
        : undefined);
    const effectiveEffort =
      patch.effort ??
      (typeof metadataEffort === "string"
        ? (metadataEffort as TaskEffort)
        : undefined);
    const effectivePriority =
      patch.priority ??
      (typeof metadataPriority === "number" ? metadataPriority : undefined);
    const effectivePolicyEpoch =
      patch.policy_epoch ??
      (typeof metadataPolicyEpoch === "number"
        ? metadataPolicyEpoch
        : undefined);
    const effectiveReportId =
      patch.report_id !== undefined
        ? patch.report_id
        : typeof metadataReportId === "string"
          ? metadataReportId
          : undefined;
    let record = before;
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

    if (
      (requestedStatus === "claimed" || requestedStatus === "running") &&
      before.status === "pending"
    ) {
      const claim = graph.tryClaim(storedId, requestedOwner ?? "task-agent", {
        expected_version: before.version,
      });
      if (!claim.ok) {
        throw new Error(`Task ${taskId} cannot be claimed: ${claim.reason}`);
      }
      record = claim.task;
      if (requestedStatus === "running") {
        record = graph.update(
          storedId,
          {
            status: "running",
            ...(effectiveKind === undefined ? {} : { kind: effectiveKind }),
            ...(effectiveEffort === undefined
              ? {}
              : { effort: effectiveEffort }),
            ...(effectivePriority === undefined
              ? {}
              : { priority: effectivePriority }),
            ...(patch.started_at === undefined
              ? {}
              : { started_at: patch.started_at }),
            ...(patch.finished_at === undefined
              ? {}
              : { finished_at: patch.finished_at }),
            ...(effectivePolicyEpoch === undefined
              ? {}
              : { policy_epoch: effectivePolicyEpoch }),
            ...(effectiveReportId === undefined
              ? {}
              : { report_id: effectiveReportId }),
          },
          record.version,
        );
      }
    } else if (
      ownerWasProvided &&
      requestedOwner !== before.owner &&
      before.status === "pending" &&
      requestedOwner !== null
    ) {
      const claim = graph.tryClaim(storedId, requestedOwner, {
        expected_version: before.version,
      });
      if (!claim.ok) {
        throw new Error(`Task ${taskId} cannot be claimed: ${claim.reason}`);
      }
      record = claim.task;
    } else {
      const graphPatch = {
        ...(requestedStatus === undefined
          ? {}
          : { status: requestedStatus as GraphTaskStatus }),
        ...(effectiveKind === undefined ? {} : { kind: effectiveKind }),
        ...(effectiveEffort === undefined ? {} : { effort: effectiveEffort }),
        ...(effectivePriority === undefined
          ? {}
          : { priority: effectivePriority }),
        ...(ownerWasProvided &&
        (requestedStatus === undefined ||
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
        ...(effectiveReportId === undefined
          ? {}
          : { report_id: effectiveReportId }),
      };
      if (Object.keys(graphPatch).length > 0) {
        const needsOverlapValidation =
          patch.blockedBy !== undefined ||
          structural.files_touched !== undefined ||
          structural.read_set !== undefined ||
          structural.write_set !== undefined ||
          structural.isolation !== undefined;
        if (needsOverlapValidation) {
          const routed = graph.routeUpdate(storedId, graphPatch, {
            expectedVersion: before.version,
          });
          if (!routed.task || !routed.decision.allowed) {
            throw new Error(
              `Task ${taskId} was rejected by overlap validation`,
            );
          }
          record = routed.task;
        } else {
          record = graph.update(storedId, graphPatch, before.version);
        }
      }
    }

    patchDetail(db, taskListId, taskId, detail, patch, effectiveMetadata);
    return normalizeGraphRecord(
      taskListId,
      record,
      readDetail(db, taskListId, taskId),
      graph.listDependents(storedId),
    );
  });
}

export async function graphDeleteTask(
  taskListId: string,
  taskId: string,
): Promise<boolean> {
  return withStores(taskListId, (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const current = graph.read(storedId);
    const detail = readDetail(db, taskListId, taskId);
    if (!current || !detail) return false;
    if (current.status !== "completed" && current.status !== "failed") {
      graph.update(storedId, { status: "completed" }, current.version);
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
  return withStores(taskListId, (graph, db) => {
    const fromStoredId = storageTaskId(taskListId, fromTaskId);
    const toStoredId = storageTaskId(taskListId, toTaskId);
    const from = graph.read(fromStoredId);
    const to = graph.read(toStoredId);
    if (
      !from ||
      !to ||
      !readDetail(db, taskListId, fromTaskId) ||
      !readDetail(db, taskListId, toTaskId)
    ) {
      return false;
    }
    if (!to.blocked_by.includes(fromStoredId)) {
      graph.update(
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
  return withStores(taskListId, (graph, db) => {
    const storedId = storageTaskId(taskListId, taskId);
    const candidateRecord = graph.read(storedId);
    const detail = readDetail(db, taskListId, taskId);
    const candidate = candidateRecord
      ? normalizeGraphRecord(
          taskListId,
          candidateRecord,
          detail,
          graph.listDependents(storedId),
        )
      : null;
    if (!candidate) return { success: false, reason: "task_not_found" };

    if (checkAgentBusy) {
      const busy = graph
        .list({ owner })
        .filter(
          (task) =>
            task.id.startsWith(taskNamespacePrefix(taskListId)) &&
            task.owner === owner &&
            task.id !== storedId &&
            !["completed", "failed"].includes(task.status),
        );
      if (busy.length > 0) {
        return {
          success: false,
          reason: "agent_busy",
          busyWithTasks: busy
            .map((task) => publicTaskId(taskListId, task.id))
            .filter((id): id is string => id !== null),
        };
      }
    }

    const result: ClaimResult = graph.tryClaim(storedId, owner);
    if (!result.ok) {
      return mapClaimFailure(
        taskListId,
        result,
        result.task
          ? normalizeGraphRecord(
              taskListId,
              result.task,
              detail,
              graph.listDependents(storedId),
            )
          : candidate,
      );
    }
    const task = normalizeGraphRecord(
      taskListId,
      result.task,
      detail,
      graph.listDependents(storedId),
    );
    if (!task) throw new Error(`Task ${taskId} was deleted during claim`);
    return { success: true, task };
  });
}

export async function graphResetTaskList(taskListId: string): Promise<void> {
  return withStores(taskListId, (graph, db) => {
    const details = readDetailsForList(db, taskListId);
    for (const task of recordsForList(graph, details, taskListId)) {
      if (task.status !== "completed" && task.status !== "failed") {
        try {
          graph.update(task.id, { status: "completed" }, task.version);
        } catch {
          // A concurrent writer owns the latest state.
        }
      }
    }
    db.prepare(
      "UPDATE task_graph_details SET deleted = 1 WHERE task_list_id = ?",
    ).run(taskListId);
  });
}
