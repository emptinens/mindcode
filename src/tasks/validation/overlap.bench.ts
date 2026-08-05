import type { TaskRecord } from "../graph/types.js";
import { findOverlaps } from "./overlap.js";

const taskCount = Number(process.env.MINDCODE_OVERLAP_BENCH_TASKS ?? 2_000);
const targetsPerTask = Number(process.env.MINDCODE_OVERLAP_BENCH_TARGETS ?? 64);
const iterations = Number(process.env.MINDCODE_OVERLAP_BENCH_ITERATIONS ?? 4);

function makeTasks(): TaskRecord[] {
  return Array.from({ length: taskCount }, (_, taskIndex) => ({
    id: `task-${taskIndex}`,
    status: "running",
    owner: `worker-${taskIndex}`,
    blocked_by: [],
    claimed_at: null,
    files_touched: [],
    read_set: Array.from(
      { length: targetsPerTask },
      (_, targetIndex) => `src/read-${targetIndex}.ts`,
    ),
    write_set: Array.from(
      { length: targetsPerTask },
      (_, targetIndex) => `src/write-${targetIndex}.ts`,
    ),
    isolation: "shared",
    lease_id: null,
    version: 0,
    policy_epoch: 0,
  })) as TaskRecord[];
}

const candidate = {
  id: "candidate",
  files_touched: [],
  read_set: Array.from(
    { length: targetsPerTask },
    (_, targetIndex) => `src/read-${targetIndex}.ts`,
  ),
  write_set: Array.from(
    { length: targetsPerTask },
    (_, targetIndex) => `src/write-${targetIndex}.ts`,
  ),
  isolation: "shared" as const,
};

function legacyFindOverlaps(
  existing: readonly TaskRecord[],
): ReturnType<typeof findOverlaps> {
  const candidateWrites = new Set(candidate.write_set);
  const candidateReads = new Set(candidate.read_set);
  const conflicts: ReturnType<typeof findOverlaps> = [];

  for (const task of existing) {
    const paths = new Set<string>();
    const kinds = new Set<"write_write" | "write_read">();
    for (const path of candidateWrites) {
      if (task.write_set.includes(path)) {
        paths.add(path);
        kinds.add("write_write");
      }
      if (task.read_set.includes(path)) {
        paths.add(path);
        kinds.add("write_read");
      }
    }
    for (const path of candidateReads) {
      if (task.write_set.includes(path)) {
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

function elapsedMs(operation: () => unknown): number {
  const started = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) {
    operation();
  }
  return Number(Bun.nanoseconds() - started) / 1_000_000;
}

const tasks = makeTasks();
for (let index = 0; index < 2; index += 1) {
  legacyFindOverlaps(tasks);
  findOverlaps(candidate, tasks);
}

const legacy = elapsedMs(() => legacyFindOverlaps(tasks));
const indexed = elapsedMs(() => findOverlaps(candidate, tasks));
const legacyConflicts = legacyFindOverlaps(tasks).length;
const indexedConflicts = findOverlaps(candidate, tasks).length;

if (legacyConflicts !== indexedConflicts) {
  throw new Error(
    `benchmark implementations disagree: ${legacyConflicts} !== ${indexedConflicts}`,
  );
}

console.log(
  JSON.stringify(
    {
      benchmark: "overlap-lookup",
      task_count: taskCount,
      targets_per_task: targetsPerTask,
      iterations,
      legacy_ms: Number(legacy.toFixed(3)),
      indexed_ms: Number(indexed.toFixed(3)),
      speedup: Number((legacy / indexed).toFixed(2)),
      conflicts: indexedConflicts,
    },
    null,
    2,
  ),
);
