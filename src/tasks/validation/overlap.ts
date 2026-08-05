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
    const existingWrites = new Set(existingSets.write_set);
    const existingReads = new Set(existingSets.read_set);
    const paths = new Set<string>();
    const kinds = new Set<OverlapKind>();

    for (const path of candidateWrites) {
      if (existingWrites.has(path)) {
        paths.add(path);
        kinds.add("write_write");
      }
      if (existingReads.has(path)) {
        paths.add(path);
        kinds.add("write_read");
      }
    }
    for (const path of candidateReads) {
      if (existingWrites.has(path)) {
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
