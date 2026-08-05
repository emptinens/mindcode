import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { TaskGraph } from "./taskGraph.js";

const dependencyCount = Number(
  process.env.MINDCODE_DEPENDENCY_BENCH_TASKS ?? 512,
);
const iterations = Number(
  process.env.MINDCODE_DEPENDENCY_BENCH_ITERATIONS ?? 24,
);

const root = mkdtempSync(join("/tmp", "mindcode-task-graph-bench-"));
const databasePath = join(root, "tasks.db");
const graph = new TaskGraph({ databasePath });
const dependencies = Array.from(
  { length: dependencyCount },
  (_, index) => `dependency-${index}`,
);
for (const id of dependencies) {
  graph.create({ id });
}

const internal = graph as unknown as {
  db: Database;
  incompleteDependenciesInTransaction(
    dependencies: readonly string[],
  ): string[];
};

function legacyLookup(ids: readonly string[]): string[] {
  const incomplete: string[] = [];
  for (const id of ids) {
    const row = internal.db
      .prepare("SELECT id, status FROM tasks WHERE id = ?")
      .get(id) as { id: string; status: string } | null | undefined;
    if (row == null || row.status !== "completed") {
      incomplete.push(id);
    }
  }
  return incomplete;
}

function elapsedMs(operation: () => unknown): number {
  const started = Bun.nanoseconds();
  for (let index = 0; index < iterations; index += 1) {
    operation();
  }
  return Number(Bun.nanoseconds() - started) / 1_000_000;
}

for (let index = 0; index < 2; index += 1) {
  legacyLookup(dependencies);
  internal.incompleteDependenciesInTransaction(dependencies);
}

const legacy = elapsedMs(() => legacyLookup(dependencies));
const indexed = elapsedMs(() =>
  internal.incompleteDependenciesInTransaction(dependencies),
);
const legacyIncomplete = legacyLookup(dependencies).length;
const indexedIncomplete =
  internal.incompleteDependenciesInTransaction(dependencies).length;

graph.close();
rmSync(root, { recursive: true, force: true });

if (legacyIncomplete !== indexedIncomplete) {
  throw new Error(
    `benchmark implementations disagree: ${legacyIncomplete} !== ${indexedIncomplete}`,
  );
}

console.log(
  JSON.stringify(
    {
      benchmark: "incomplete-dependencies",
      dependency_count: dependencyCount,
      iterations,
      legacy_ms: Number(legacy.toFixed(3)),
      indexed_ms: Number(indexed.toFixed(3)),
      speedup: Number((legacy / indexed).toFixed(2)),
      incomplete_dependencies: indexedIncomplete,
    },
    null,
    2,
  ),
);
