import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

import { TaskGraph } from "./taskGraph.js";

const openGraphs: TaskGraph[] = [];

afterEach(() => {
  for (const graph of openGraphs.splice(0)) graph.close();
});

function databasePath(): string {
  return join(mkdtempSync(join("/tmp", "mindcode-overlap-")), "tasks.db");
}

function graph(path = databasePath()): TaskGraph {
  const instance = new TaskGraph({ databasePath: path });
  openGraphs.push(instance);
  return instance;
}

describe("atomic overlap validation", () => {
  test("blocks write/write and reports normalized targets", () => {
    const taskGraph = graph();
    const first = taskGraph.route({
      id: "writer-a",
      write_set: ["./src/a.ts"],
    });
    const second = taskGraph.route({ id: "writer-b", write_set: ["src/a.ts"] });

    expect(first.decision.action).toBe("allow");
    expect(second.decision).toMatchObject({
      action: "blocked",
      allowed: true,
      blocked_by: ["writer-a"],
    });
    expect(second.decision.conflicts).toEqual([
      expect.objectContaining({
        task_id: "writer-a",
        paths: ["src/a.ts"],
        kinds: ["write_write"],
      }),
    ]);
    expect(second.task).toMatchObject({
      status: "pending",
      blocked_by: ["writer-a"],
    });
  });

  test("blocks write/read in either direction but permits read/read", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "writer", write_set: ["src/a.ts"] });
    const reader = taskGraph.route({ id: "reader", read_set: ["src/a.ts"] });
    expect(reader.decision.action).toBe("blocked");
    expect(reader.decision.conflicts[0]?.kinds).toEqual(["write_read"]);

    const readOnlyGraph = graph();
    readOnlyGraph.route({ id: "read-a", read_set: ["src/b.ts"] });
    const readB = readOnlyGraph.route({ id: "read-b", read_set: ["src/b.ts"] });
    expect(readB.decision.action).toBe("allow");
    expect(readB.task?.blocked_by).toEqual([]);
  });

  test("preserves both conflict kinds for targets indexed with read and write access", () => {
    const taskGraph = graph();
    taskGraph.route({
      id: "mixed-owner",
      read_set: ["src/a.ts"],
      write_set: ["src/a.ts", "src/b.ts"],
    });

    const result = taskGraph.route({
      id: "mixed-candidate",
      read_set: ["src/a.ts"],
      write_set: ["src/a.ts", "src/b.ts"],
    });

    expect(result.decision.conflicts).toEqual([
      expect.objectContaining({
        task_id: "mixed-owner",
        paths: ["src/a.ts", "src/b.ts"],
        kinds: ["write_read", "write_write"],
      }),
    ]);
  });

  test("uses files_touched as a conservative write set", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "legacy", files_touched: ["src/legacy.ts"] });
    const result = taskGraph.route({
      id: "reader",
      read_set: ["src/legacy.ts"],
    });
    expect(result.decision.action).toBe("blocked");
    expect(result.decision.conflicts[0]?.kinds).toEqual(["write_read"]);
  });

  test("blocks scoped targets against legacy targets in either route order", () => {
    const legacyFirst = graph();
    legacyFirst.route({ id: "legacy", write_set: ["src/shared.ts"] });
    const scopedAfter = legacyFirst.route({
      id: "scoped",
      write_set: [".mindcode-target-scope/hash-a/src/shared.ts"],
    });
    expect(scopedAfter.decision.action).toBe("blocked");

    const scopedFirst = graph();
    scopedFirst.route({
      id: "scoped",
      write_set: [".mindcode-target-scope/hash-a/src/shared.ts"],
    });
    const legacyAfter = scopedFirst.route({
      id: "legacy",
      write_set: ["src/shared.ts"],
    });
    expect(legacyAfter.decision.action).toBe("blocked");
  });

  test("allows scoped targets with different hashes", () => {
    const taskGraph = graph();
    taskGraph.route({
      id: "scoped-a",
      write_set: [".mindcode-target-scope/hash-a/src/shared.ts"],
    });
    const result = taskGraph.route({
      id: "scoped-b",
      write_set: [".mindcode-target-scope/hash-b/src/shared.ts"],
    });
    expect(result.decision.action).toBe("allow");
  });

  test("blocks identical scoped targets", () => {
    const taskGraph = graph();
    taskGraph.route({
      id: "scoped-a",
      write_set: [".mindcode-target-scope/hash-a/src/shared.ts"],
    });
    const result = taskGraph.route({
      id: "scoped-b",
      write_set: [".mindcode-target-scope/hash-a/src/shared.ts"],
    });
    expect(result.decision.action).toBe("blocked");
  });

  test("terminal tasks do not block a new route", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "finished", write_set: ["src/a.ts"] });
    taskGraph.update("finished", { status: "completed" });
    const result = taskGraph.route({ id: "next", write_set: ["src/a.ts"] });
    expect(result.decision.action).toBe("allow");
    expect(result.task?.blocked_by).toEqual([]);
  });

  test("explicit worktree isolation bypass is recorded", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "shared", write_set: ["src/a.ts"] });
    const result = taskGraph.route({
      id: "isolated",
      write_set: ["src/a.ts"],
      isolation: "worktree",
    });
    expect(result.decision).toMatchObject({
      action: "worktree_isolated",
      allowed: true,
      isolation: "worktree",
    });
    expect(result.task).toMatchObject({
      isolation: "worktree",
      blocked_by: [],
    });
  });

  test("merges explicit dependencies and overlap dependencies atomically", () => {
    const taskGraph = graph();
    taskGraph.create({ id: "dependency" });
    taskGraph.route({ id: "owner", write_set: ["src/a.ts"] });
    const result = taskGraph.route({
      id: "blocked",
      read_set: ["src/a.ts"],
      blocked_by: ["dependency"],
    });
    expect(result.task?.blocked_by).toEqual(["dependency", "owner"]);
    expect(result.decision.blocked_by).toEqual(["dependency", "owner"]);
  });

  test("reject mode returns a typed decision without creating a task", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "owner", write_set: ["src/a.ts"] });
    const result = taskGraph.route(
      { id: "rejected", write_set: ["src/a.ts"] },
      { mode: "reject" },
    );
    expect(result).toMatchObject({
      task: null,
      created: false,
      decision: { action: "rejected", allowed: false },
    });
    expect(taskGraph.read("rejected")).toBeNull();
  });

  test("two simultaneous routes cannot both pass overlap validation", async () => {
    const path = databasePath();
    const first = graph(path);
    const second = graph(path);
    const results = await Promise.all([
      Promise.resolve().then(() =>
        first.route({ id: "race-a", write_set: ["src/race.ts"] }),
      ),
      Promise.resolve().then(() =>
        second.route({ id: "race-b", write_set: ["src/race.ts"] }),
      ),
    ]);
    expect(
      results.filter((result) => result.decision.action === "allow"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.decision.action === "blocked"),
    ).toHaveLength(1);
    expect(first.list()).toHaveLength(2);
  });

  test("idempotency returns the original routed task", () => {
    const taskGraph = graph();
    const first = taskGraph.route({
      id: "idempotent",
      write_set: ["src/a.ts"],
      idempotency_key: "route-1",
    });
    const second = taskGraph.route({
      id: "different-id",
      write_set: ["src/a.ts"],
      idempotency_key: "route-1",
    });
    expect(second.created).toBe(false);
    expect(second.decision.action).toBe("idempotent");
    expect(second.task).toEqual(first.task);
    expect(taskGraph.list()).toHaveLength(1);
  });

  test("rejects traversal and absolute or ambiguous targets", () => {
    const taskGraph = graph();
    for (const target of ["../secret", "/tmp/file", "", "src//a.ts"]) {
      expect(() => taskGraph.route({ write_set: [target] })).toThrow();
    }
  });

  test("routeUpdate applies the same atomic dependency decision and CAS", () => {
    const taskGraph = graph();
    taskGraph.route({ id: "owner", write_set: ["src/a.ts"] });
    const candidate = taskGraph.route({
      id: "candidate",
      write_set: ["src/b.ts"],
    });
    const blocked = taskGraph.routeUpdate(
      "candidate",
      { write_set: ["src/a.ts"] },
      { expectedVersion: candidate.task?.version },
    );
    expect(blocked.decision.action).toBe("blocked");
    expect(blocked.task?.blocked_by).toEqual(["owner"]);
    expect(() =>
      taskGraph.routeUpdate(
        "candidate",
        { read_set: ["src/c.ts"] },
        { expectedVersion: candidate.task?.version },
      ),
    ).toThrow();
  });
});
