import type { TaskIsolation, TaskRecord, TaskStatus } from "../graph/types.js";
export type OverlapKind = "write_write" | "write_read";

export interface OverlapConflict {
  task_id: string;
  paths: string[];
  kinds: OverlapKind[];
  existing_isolation: TaskIsolation;
  new_isolation: TaskIsolation;
}

export interface OverlapDecision {
  action: "allow" | "blocked" | "worktree_isolated" | "rejected" | "idempotent";
  allowed: boolean;
  mode: "block" | "reject";
  isolation: TaskIsolation;
  conflicts: OverlapConflict[];
  blocked_by: string[];
}

export interface EffectiveTargetSets {
  read_set: readonly string[];
  write_set: readonly string[];
}

export interface OverlapCandidate {
  id: string;
  files_touched: readonly string[];
  read_set: readonly string[];
  write_set: readonly string[];
  isolation: TaskIsolation;
  explicit_sets?: boolean;
}

const TERMINAL_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const TARGET_SCOPE_PREFIX = ".mindcode-target-scope/";

interface ScopedTarget {
  hash: string;
  logicalPath: string;
}

interface TargetLookup {
  exact: Set<string>;
  legacy: Set<string>;
  scopedByLogicalPath: Map<string, Set<string>>;
}

function parseScopedTarget(target: string): ScopedTarget | null {
  if (!target.startsWith(TARGET_SCOPE_PREFIX)) return null;
  const scopedPath = target.slice(TARGET_SCOPE_PREFIX.length);
  const separator = scopedPath.indexOf("/");
  if (separator <= 0 || separator === scopedPath.length - 1) return null;
  return {
    hash: scopedPath.slice(0, separator),
    logicalPath: scopedPath.slice(separator + 1),
  };
}

function indexTargets(targets: Iterable<string>): TargetLookup {
  const lookup: TargetLookup = {
    exact: new Set<string>(),
    legacy: new Set<string>(),
    scopedByLogicalPath: new Map<string, Set<string>>(),
  };
  for (const target of targets) {
    lookup.exact.add(target);
    const scoped = parseScopedTarget(target);
    if (!scoped) {
      lookup.legacy.add(target);
      continue;
    }
    const hashes = lookup.scopedByLogicalPath.get(scoped.logicalPath);
    if (hashes) {
      hashes.add(scoped.hash);
    } else {
      lookup.scopedByLogicalPath.set(
        scoped.logicalPath,
        new Set([scoped.hash]),
      );
    }
  }
  return lookup;
}

function targetsOverlap(target: string, existing: TargetLookup): boolean {
  if (existing.exact.has(target)) return true;
  const scoped = parseScopedTarget(target);
  if (!scoped) {
    return existing.scopedByLogicalPath.has(target);
  }
  return existing.legacy.has(scoped.logicalPath);
}

export function effectiveTargetSets(
  task: Pick<OverlapCandidate, "files_touched" | "read_set" | "write_set"> & {
    explicit_sets?: boolean;
  },
): EffectiveTargetSets {
  if (
    task.explicit_sets ||
    task.read_set.length > 0 ||
    task.write_set.length > 0
  ) {
    return { read_set: task.read_set, write_set: task.write_set };
  }
  // Legacy tasks and callers that only provide files_touched are writers.
  return { read_set: [], write_set: task.files_touched };
}

export function findOverlaps(
  candidate: OverlapCandidate,
  existing: readonly (TaskRecord & { explicit_sets?: boolean })[],
): OverlapConflict[] {
  const candidateSets = effectiveTargetSets(candidate);
  const candidateWrites = new Set(candidateSets.write_set);
  const candidateReads = new Set(candidateSets.read_set);
  const conflicts: OverlapConflict[] = [];

  for (const task of existing) {
    if (task.id === candidate.id || TERMINAL_STATUSES.has(task.status)) {
      continue;
    }
    const existingSets = effectiveTargetSets(task);
    // Build each task's access lookup once. This keeps the public arrays
    // unchanged while replacing repeated Array.includes scans with O(1) Set
    // membership checks.
    const existingWrites = indexTargets(existingSets.write_set);
    const existingReads = indexTargets(existingSets.read_set);
    const paths = new Set<string>();
    const kinds = new Set<OverlapKind>();

    for (const path of candidateWrites) {
      if (targetsOverlap(path, existingWrites)) {
        paths.add(path);
        kinds.add("write_write");
      }
      if (targetsOverlap(path, existingReads)) {
        paths.add(path);
        kinds.add("write_read");
      }
    }
    for (const path of candidateReads) {
      if (targetsOverlap(path, existingWrites)) {
        paths.add(path);
        kinds.add("write_read");
      }
    }

    if (paths.size > 0) {
      conflicts.push({
        task_id: task.id,
        paths: [...paths].sort(),
        kinds: [...kinds].sort(),
        existing_isolation: task.isolation,
        new_isolation: candidate.isolation,
      });
    }
  }

  return conflicts.sort((left, right) =>
    left.task_id.localeCompare(right.task_id),
  );
}

export function makeOverlapDecision(
  isolation: TaskIsolation,
  conflicts: OverlapConflict[],
  blockedBy: readonly string[],
  mode: "block" | "reject" = "block",
): OverlapDecision {
  const ids = [...new Set(blockedBy)];
  if (conflicts.length === 0) {
    return {
      action: "allow",
      allowed: true,
      mode,
      isolation,
      conflicts: [],
      blocked_by: ids,
    };
  }
  if (isolation === "worktree") {
    return {
      action: "worktree_isolated",
      allowed: true,
      mode,
      isolation,
      conflicts,
      blocked_by: ids,
    };
  }
  if (mode === "reject") {
    return {
      action: "rejected",
      allowed: false,
      mode,
      isolation,
      conflicts,
      blocked_by: ids,
    };
  }
  return {
    action: "blocked",
    allowed: true,
    mode,
    isolation,
    conflicts,
    blocked_by: ids,
  };
}
