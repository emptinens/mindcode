import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { ensureTaskGraphPaths } from "../../storage/taskGraphPaths.js";
import type { RecoveryResult } from "../../tasks/graph/types.js";
import { type WorkerTaskGraph, createWorkerTaskGraph } from "./workerGraph.js";

const MAX_RECOVERY_AUDIT_ENTRIES = 64;
const MAX_RECOVERY_ERROR_BYTES = 512;
const RECOVERY_AUDIT_FILE = "recovery.jsonl";

export type WorkerRecoverySource = "startup" | "resume" | "daemon";

export type WorkerRecoveryAuditEntry = {
  source: WorkerRecoverySource;
  attempted_at: string;
  completed_at: string;
  expired_lease_count: number;
  recovered_task_count: number;
  ok: boolean;
  error?: string;
};

let latestRecoveryValue: WorkerRecoveryAuditEntry | null = null;
const recoveryEntries: WorkerRecoveryAuditEntry[] = [];

function boundedError(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.length > MAX_RECOVERY_ERROR_BYTES
    ? `${value.slice(0, MAX_RECOVERY_ERROR_BYTES - 3)}...`
    : value;
}

function remember(entry: WorkerRecoveryAuditEntry): void {
  latestRecoveryValue = entry;
  recoveryEntries.push(entry);
  if (recoveryEntries.length > MAX_RECOVERY_AUDIT_ENTRIES) {
    recoveryEntries.splice(
      0,
      recoveryEntries.length - MAX_RECOVERY_AUDIT_ENTRIES,
    );
  }
}

async function persist(entry: WorkerRecoveryAuditEntry): Promise<void> {
  const paths = ensureTaskGraphPaths();
  await mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const auditPath = `${paths.stateDir}/${RECOVERY_AUDIT_FILE}`;
  let previous: string[] = [];
  try {
    previous = (await readFile(auditPath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .slice(-MAX_RECOVERY_AUDIT_ENTRIES);
  } catch {
    // The first recovery has no existing audit file.
  }
  const content = `${[...previous, JSON.stringify(entry)].slice(-MAX_RECOVERY_AUDIT_ENTRIES).join("\n")}\n`;
  const temporaryPath = `${auditPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, auditPath);
  await chmod(auditPath, 0o600);
}

export function getWorkerRecoveryStatus(): WorkerRecoveryAuditEntry | null {
  return latestRecoveryValue;
}

export function getWorkerRecoveryEntries(): readonly WorkerRecoveryAuditEntry[] {
  return [...recoveryEntries];
}

export async function readWorkerRecoveryAudit(
  limit = 32,
): Promise<WorkerRecoveryAuditEntry[]> {
  const boundedLimit = Math.max(
    1,
    Math.min(MAX_RECOVERY_AUDIT_ENTRIES, Math.floor(limit)),
  );
  try {
    const paths = ensureTaskGraphPaths();
    const content = await readFile(
      `${paths.stateDir}/${RECOVERY_AUDIT_FILE}`,
      "utf8",
    );
    const parsed: WorkerRecoveryAuditEntry[] = [];
    for (const line of content.split("\n").slice(-boundedLimit)) {
      if (!line.trim()) continue;
      try {
        const value = JSON.parse(line) as Partial<WorkerRecoveryAuditEntry>;
        if (
          (value.source === "startup" ||
            value.source === "resume" ||
            value.source === "daemon") &&
          typeof value.attempted_at === "string" &&
          typeof value.completed_at === "string" &&
          Number.isSafeInteger(value.expired_lease_count) &&
          Number.isSafeInteger(value.recovered_task_count) &&
          typeof value.ok === "boolean"
        ) {
          const expiredLeaseCount = value.expired_lease_count;
          const recoveredTaskCount = value.recovered_task_count;
          if (
            expiredLeaseCount === undefined ||
            recoveredTaskCount === undefined
          )
            continue;
          parsed.push({
            source: value.source,
            attempted_at: value.attempted_at,
            completed_at: value.completed_at,
            expired_lease_count: Math.max(0, expiredLeaseCount),
            recovered_task_count: Math.max(0, recoveredTaskCount),
            ok: value.ok,
            ...(typeof value.error === "string"
              ? { error: boundedError(value.error) }
              : {}),
          });
        }
      } catch {
        // Ignore malformed audit lines; recovery state remains authoritative.
      }
    }
    return parsed;
  } catch {
    return [];
  }
}

export type WorkerRecoveryOptions = {
  source: WorkerRecoverySource;
  graph?: WorkerTaskGraph;
  now?: string | Date;
  signal?: AbortSignal;
  persistAudit?: boolean;
};

export type WorkerRecoveryResult = {
  audit: WorkerRecoveryAuditEntry;
  recovery: RecoveryResult | null;
};

export async function reconcileWorkerTaskGraph(
  options: WorkerRecoveryOptions,
): Promise<WorkerRecoveryResult> {
  const attemptedAt = new Date().toISOString();
  const graph = options.graph ?? createWorkerTaskGraph();
  const ownsGraph = options.graph === undefined;
  try {
    const recovery = await graph.recover(options.now, options.signal);
    const audit: WorkerRecoveryAuditEntry = {
      source: options.source,
      attempted_at: attemptedAt,
      completed_at: new Date().toISOString(),
      expired_lease_count: recovery.expired_leases.length,
      recovered_task_count: recovery.recovered_tasks.length,
      ok: true,
    };
    remember(audit);
    if (options.persistAudit !== false) {
      try {
        await persist(audit);
      } catch {
        // Recovery state remains authoritative when diagnostics cannot persist.
      }
    }
    return { audit, recovery };
  } catch (error) {
    const audit: WorkerRecoveryAuditEntry = {
      source: options.source,
      attempted_at: attemptedAt,
      completed_at: new Date().toISOString(),
      expired_lease_count: 0,
      recovered_task_count: 0,
      ok: false,
      error: boundedError(error),
    };
    remember(audit);
    if (options.persistAudit !== false) {
      try {
        await persist(audit);
      } catch {
        // Recovery diagnostics must never mask the original recovery failure.
      }
    }
    return { audit, recovery: null };
  } finally {
    if (ownsGraph) await graph.close().catch(() => undefined);
  }
}
