import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskGraph } from "../../tasks/graph/taskGraph.js";
import { createTestWorkerTaskGraph } from "./workerGraph.js";
import {
  readWorkerRecoveryAudit,
  reconcileWorkerTaskGraph,
} from "./recovery.js";

const directories: string[] = [];

async function createGraph(): Promise<TaskGraph> {
  const directory = await mkdtemp(join(tmpdir(), "mindcode-recovery-"));
  directories.push(directory);
  return new TaskGraph({ databasePath: join(directory, "tasks.db") });
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("worker recovery", () => {
  test("reconciles expired leases idempotently and persists bounded audit metadata", async () => {
    const graph = await createGraph();
    await graph.route({ id: "stale" });
    const claim = graph.claimTask("stale", "worker", {
      ttl_ms: 1,
      now: "2026-08-11T00:00:00.000Z",
    });
    expect(claim.ok).toBe(true);

    const first = await reconcileWorkerTaskGraph({
      source: "resume",
      graph: createTestWorkerTaskGraph(graph),
      now: "2026-08-11T00:00:01.000Z",
      persistAudit: false,
    });
    expect(first.audit).toMatchObject({
      source: "resume",
      ok: true,
      expired_lease_count: 1,
      recovered_task_count: 1,
    });
    expect(first.recovery?.recovered_tasks[0]?.status).toBe("pending");

    const second = await reconcileWorkerTaskGraph({
      source: "resume",
      graph: createTestWorkerTaskGraph(graph),
      now: "2026-08-11T00:00:02.000Z",
      persistAudit: false,
    });
    expect(second.audit.expired_lease_count).toBe(0);
    expect(second.audit.recovered_task_count).toBe(0);
  });

  test("writes only metadata-only audit entries when persistence is enabled", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "mindcode-recovery-config-"),
    );
    directories.push(directory);
    const previous = process.env.MINDCODE_CONFIG_DIR;
    process.env.MINDCODE_CONFIG_DIR = directory;
    try {
      const graph = await createGraph();
      const result = await reconcileWorkerTaskGraph({
        source: "startup",
        graph: createTestWorkerTaskGraph(graph),
      });
      expect(result.audit.ok).toBe(true);
      const entries = await readWorkerRecoveryAudit();
      expect(entries).toHaveLength(1);
      const raw = await readFile(
        join(directory, "state", "recovery.jsonl"),
        "utf8",
      );
      expect(raw).not.toContain("prompt");
      expect(raw).not.toContain("transcript");
      expect(raw).toContain('"source":"startup"');
    } finally {
      if (previous === undefined)
        Reflect.deleteProperty(process.env, "MINDCODE_CONFIG_DIR");
      else process.env.MINDCODE_CONFIG_DIR = previous;
    }
  });
});
