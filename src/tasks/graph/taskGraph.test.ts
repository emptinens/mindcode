import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  ensureTaskGraphPaths,
  getTaskGraphPaths,
  resolveMindCodeConfigDir,
} from "../../storage/taskGraphPaths.js";
import {
  DependencyCycleError,
  DependencyNotFoundError,
  VersionConflictError,
} from "./errors.js";
import { TaskGraph } from "./taskGraph.js";
import type { TaskGraphSnapshot } from "./types.js";

const openGraphs: TaskGraph[] = [];

afterEach(() => {
  for (const graph of openGraphs.splice(0)) {
    graph.close();
  }
});

function databasePath(): string {
  return join(
    mkdtempSync(join("/tmp", "mindcode-task-graph-")),
    "state",
    "tasks.db",
  );
}

function graph(
  options: ConstructorParameters<typeof TaskGraph>[0] = {},
): TaskGraph {
  const instance = new TaskGraph({ databasePath: databasePath(), ...options });
  openGraphs.push(instance);
  return instance;
}

function graphAt(
  path: string,
  options: ConstructorParameters<typeof TaskGraph>[0] = {},
): TaskGraph {
  const instance = new TaskGraph({ databasePath: path, ...options });
  openGraphs.push(instance);
  return instance;
}

function databaseColumns(path: string): string[] {
  const database = new Database(path);
  const columns = (
    database.prepare("PRAGMA table_info(tasks)").all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
  database.close();
  return columns;
}

describe("task graph paths", () => {
  test("uses ~/.mindcode/state/tasks.db by default", () => {
    expect(getTaskGraphPaths({}).databasePath).toBe(
      join(homedir(), ".mindcode", "state", "tasks.db"),
    );
  });

  test("honors an absolute and a tilde MINDCODE_CONFIG_DIR override", () => {
    const absolute = "/tmp/mindcode-config-override";
    expect(resolveMindCodeConfigDir({ MINDCODE_CONFIG_DIR: absolute })).toBe(
      absolute,
    );
    expect(
      resolveMindCodeConfigDir({ MINDCODE_CONFIG_DIR: "~/.custom-mindcode" }),
    ).toBe(join(homedir(), ".custom-mindcode"));
    expect(getTaskGraphPaths({ MINDCODE_CONFIG_DIR: absolute })).toMatchObject({
      configDir: absolute,
      stateDir: join(absolute, "state"),
      databasePath: join(absolute, "state", "tasks.db"),
      tasksDb: join(absolute, "state", "tasks.db"),
      mailboxDatabasePath: join(absolute, "state", "mailbox.db"),
      mailboxDb: join(absolute, "state", "mailbox.db"),
      reportsDir: join(absolute, "state", "reports"),
      runsDir: join(absolute, "state", "runs"),
    });

    const ensured = ensureTaskGraphPaths({ MINDCODE_CONFIG_DIR: absolute });
    expect(ensured.reportsDir).toBe(join(absolute, "state", "reports"));
    expect(existsSync(ensured.reportsDir)).toBe(true);
    expect(existsSync(ensured.runsDir)).toBe(true);
  });

  test("keeps mailbox, reports, and runs outside the task graph database", () => {
    const paths = getTaskGraphPaths({
      MINDCODE_CONFIG_DIR: "/tmp/mindcode-storage",
    });
    expect(paths.mailboxDatabasePath).not.toBe(paths.databasePath);
    expect(paths.reportsDir).not.toBe(paths.stateDir);
    expect(paths.runsDir).not.toBe(paths.stateDir);
  });
});

describe("SQLite task graph core", () => {
  test("creates, reads, lists, updates, and persists the requested schema", () => {
    const taskGraph = graph();
    const created = taskGraph.create({
      id: "task-a",
      files_touched: ["src/a.ts"],
      read_set: ["src/input.ts"],
      write_set: ["src/a.ts"],
      policy_epoch: 7,
    });

    expect(created).toEqual({
      id: "task-a",
      status: "pending",
      owner: null,
      kind: "implement",
      effort: "medium",
      priority: 0,
      blocked_by: [],
      claimed_at: null,
      started_at: null,
      finished_at: null,
      files_touched: ["src/a.ts"],
      read_set: ["src/input.ts"],
      write_set: ["src/a.ts"],
      isolation: "shared",
      lease_id: null,
      version: 0,
      policy_epoch: 7,
      report_id: null,
    });
    expect(taskGraph.read("task-a")).toEqual(created);
    expect(taskGraph.list()).toEqual([created]);

    const updated = taskGraph.update(
      "task-a",
      {
        owner: "leader",
        files_touched: ["src/a.ts", "src/a.test.ts"],
        policy_epoch: 8,
      },
      { expectedVersion: 0 },
    );
    expect(updated).toMatchObject({
      id: "task-a",
      owner: "leader",
      files_touched: ["src/a.ts", "src/a.test.ts"],
      policy_epoch: 8,
      version: 1,
    });
    expect(taskGraph.list({ owner: "leader" })).toEqual([updated]);
    expect(taskGraph.graphVersion()).toBe(2);
  });

  test("uses idempotency keys to return one durable task", () => {
    const taskGraph = graph();
    const first = taskGraph.create({
      id: "first",
      idempotency_key: "request-1",
    });
    const second = taskGraph.create({
      id: "different-id",
      idempotencyKey: "request-1",
    });

    expect(second).toEqual(first);
    expect(taskGraph.list()).toHaveLength(1);
  });

  test("persists the full task lifecycle schema and all supported efforts", () => {
    let now = new Date("2026-08-05T01:00:00.000Z");
    const taskGraph = graph({ clock: () => new Date(now) });
    const created = taskGraph.create({
      id: "rich-task",
      kind: "research",
      effort: "xhigh",
      priority: 12,
      read_set: ["docs/input.md"],
      write_set: ["docs/output.md"],
      files_touched: ["docs/output.md"],
      policy_epoch: 4,
      report_id: "report-before-run",
    });

    expect(created).toMatchObject({
      kind: "research",
      effort: "xhigh",
      priority: 12,
      started_at: null,
      finished_at: null,
      report_id: "report-before-run",
    });

    const none = taskGraph.create({ id: "none-effort", effort: "none" });
    expect(none.effort).toBe("none");

    const lease = taskGraph.acquireLease("rich-task", "worker", {
      lease_id: "rich-lease",
    });
    expect(lease?.lease_id).toBe("rich-lease");
    now = new Date("2026-08-05T01:00:05.000Z");
    const running = taskGraph.update("rich-task", { status: "running" });
    expect(running).toMatchObject({
      status: "running",
      started_at: "2026-08-05T01:00:05.000Z",
      finished_at: null,
    });

    now = new Date("2026-08-05T01:00:10.000Z");
    const finished = taskGraph.update("rich-task", {
      status: "completed",
      report_id: "report-after-run",
    });
    expect(finished).toMatchObject({
      status: "completed",
      started_at: "2026-08-05T01:00:05.000Z",
      finished_at: "2026-08-05T01:00:10.000Z",
      report_id: "report-after-run",
    });

    taskGraph.close();
    const reopened = graphAt(taskGraph.databasePath, {
      clock: () => new Date(now),
    });
    expect(reopened.requireTask("rich-task")).toEqual(finished);
  });

  test("migrates an older tasks.db additively without losing legacy fields", () => {
    const path = databasePath();
    mkdirSync(dirname(path), { recursive: true });
    const database = new Database(path);
    database.exec(`
      CREATE TABLE task_graph_meta (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      INSERT INTO task_graph_meta(key, value) VALUES ('graph_version', '9');
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        status TEXT NOT NULL,
        owner TEXT,
        blocked_by TEXT NOT NULL DEFAULT '[]',
        claimed_at TEXT,
        files_touched TEXT NOT NULL DEFAULT '[]',
        lease_id TEXT,
        version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE task_leases (
        lease_id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL,
        owner TEXT NOT NULL,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        released_at TEXT
      );
      CREATE TABLE task_idempotency (
        idempotency_key TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL
      );
    `);
    database
      .prepare(
        "INSERT INTO tasks(id, status, owner, blocked_by, claimed_at, files_touched, lease_id, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "legacy-task",
        "claimed",
        "legacy-worker",
        JSON.stringify(["dependency"]),
        "2026-08-05T00:00:00.000Z",
        JSON.stringify(["legacy.ts"]),
        "legacy-lease",
        17,
      );
    database.close();

    const reopened = graphAt(path);
    expect(reopened.requireTask("legacy-task")).toMatchObject({
      id: "legacy-task",
      status: "claimed",
      owner: "legacy-worker",
      blocked_by: ["dependency"],
      claimed_at: "2026-08-05T00:00:00.000Z",
      files_touched: ["legacy.ts"],
      lease_id: "legacy-lease",
      version: 17,
      kind: "implement",
      effort: "medium",
      priority: 0,
      read_set: [],
      write_set: [],
      started_at: null,
      finished_at: null,
      policy_epoch: 0,
      report_id: null,
    });
    const columns = databaseColumns(path);
    expect(columns).toEqual(
      expect.arrayContaining([
        "kind",
        "effort",
        "priority",
        "read_set",
        "write_set",
        "started_at",
        "finished_at",
        "policy_epoch",
        "report_id",
      ]),
    );
  });

  test("returns only direct dependents from the targeted dependency query", () => {
    const taskGraph = graph();
    taskGraph.create({ id: "root" });
    taskGraph.create({ id: "dependent", blocked_by: ["root"] });
    taskGraph.create({ id: "unrelated" });
    expect(taskGraph.listDependents("root").map((task) => task.id)).toEqual([
      "dependent",
    ]);
    expect(taskGraph.listDependents("unrelated")).toEqual([]);
  });

  test("performs optimistic version CAS without applying a stale mutation", () => {
    const taskGraph = graph();
    const task = taskGraph.create({ id: "cas" });
    const next = taskGraph.compareAndSwap("cas", task.version, {
      owner: "worker-a",
    });
    expect(next).toMatchObject({ owner: "worker-a", version: 1 });

    expect(
      taskGraph.compareAndSwap("cas", task.version, { owner: "worker-b" }),
    ).toBeNull();
    expect(() =>
      taskGraph.updateTask("cas", { owner: "worker-b" }, task.version),
    ).toThrow(VersionConflictError);
    expect(taskGraph.requireTask("cas").owner).toBe("worker-a");
  });

  test("rejects missing dependencies and direct or indirect cycles before writing", () => {
    const taskGraph = graph();
    expect(() =>
      taskGraph.create({ id: "missing-child", blocked_by: ["missing"] }),
    ).toThrow(DependencyNotFoundError);

    taskGraph.create({ id: "a" });
    taskGraph.create({ id: "b", blocked_by: ["a"] });
    expect(() => taskGraph.update("a", { blocked_by: ["b"] })).toThrow(
      DependencyCycleError,
    );

    taskGraph.create({ id: "c", blocked_by: ["b"] });
    expect(() => taskGraph.update("a", { blocked_by: ["c"] })).toThrow(
      DependencyCycleError,
    );
    expect(taskGraph.requireTask("a").blocked_by).toEqual([]);
    expect(() =>
      taskGraph.create({ id: "self", blocked_by: ["self"] }),
    ).toThrow(DependencyCycleError);
  });

  test("gates claims until every dependency is completed", () => {
    const taskGraph = graph();
    taskGraph.create({ id: "dependency" });
    taskGraph.create({ id: "dependent", blocked_by: ["dependency"] });

    const blocked = taskGraph.tryClaim("dependent", "worker");
    expect(blocked).toMatchObject({
      ok: false,
      reason: "dependencies_incomplete",
      blocked_by: ["dependency"],
    });
    expect(taskGraph.claim("dependent", "worker")).toBeNull();

    taskGraph.update(
      "dependency",
      { status: "completed" },
      { expectedVersion: 0 },
    );
    const claimed = taskGraph.tryClaim("dependent", "worker");
    expect(claimed.ok).toBe(true);
    if (claimed.ok) {
      expect(claimed.task.status).toBe("claimed");
      expect(claimed.task.lease_id).toBe(claimed.lease.lease_id);
    }
  });

  test("preserves missing and incomplete dependency ordering after an external delete", () => {
    const path = databasePath();
    const taskGraph = graphAt(path);
    taskGraph.create({ id: "complete" });
    taskGraph.create({ id: "pending" });
    taskGraph.create({ id: "missing-a" });
    taskGraph.create({ id: "missing-b" });
    taskGraph.create({
      id: "dependent-with-missing",
      blocked_by: ["complete", "missing-a", "pending", "missing-b"],
    });
    taskGraph.update("complete", { status: "completed" });
    taskGraph.close();

    const database = new Database(path);
    database
      .prepare("DELETE FROM tasks WHERE id IN (?, ?)")
      .run("missing-a", "missing-b");
    database.close();

    const reopened = graphAt(path);
    expect(reopened.tryClaim("dependent-with-missing", "worker")).toEqual({
      ok: false,
      reason: "dependencies_incomplete",
      task: expect.objectContaining({
        id: "dependent-with-missing",
        status: "pending",
      }),
      blocked_by: ["missing-a", "pending", "missing-b"],
    });
  });

  test("many parallel claims have exactly one winner", async () => {
    const path = databasePath();
    const creator = graphAt(path);
    creator.create({ id: "race-task" });

    const claimers = Array.from({ length: 48 }, (_, index) => graphAt(path));
    const results = await Promise.all(
      claimers.map((claimingGraph, index) =>
        Promise.resolve(claimingGraph.tryClaim("race-task", `worker-${index}`)),
      ),
    );
    const winners = results.filter((result) => result.ok);

    expect(winners).toHaveLength(1);
    expect(creator.requireTask("race-task").status).toBe("claimed");
    expect(creator.list({ status: "claimed" })).toHaveLength(1);
  });

  test("many parallel claims with completed dependencies still have one winner", async () => {
    const path = databasePath();
    const creator = graphAt(path);
    const dependencies = Array.from(
      { length: 24 },
      (_, index) => `dep-${index}`,
    );
    for (const id of dependencies) {
      creator.create({ id });
      creator.update(id, { status: "completed" });
    }
    creator.create({ id: "dependent-race", blocked_by: dependencies });

    const claimers = Array.from({ length: 24 }, (_, index) => graphAt(path));
    const results = await Promise.all(
      claimers.map((claimingGraph, index) =>
        Promise.resolve(
          claimingGraph.tryClaim("dependent-race", `worker-${index}`),
        ),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(creator.requireTask("dependent-race")).toMatchObject({
      status: "claimed",
      owner: expect.stringMatching(/^worker-/),
    });
  });

  test("lease acquisition is idempotent, releases, expires, and recovers tasks", () => {
    let now = new Date("2026-08-05T00:00:00.000Z");
    const taskGraph = graph({
      clock: () => new Date(now),
      leaseTtlMs: 1_000,
    });
    taskGraph.create({ id: "leased" });

    const firstLease = taskGraph.acquireLease("leased", "worker", {
      lease_id: "lease-1",
    });
    expect(firstLease).toMatchObject({
      lease_id: "lease-1",
      task_id: "leased",
      owner: "worker",
      expires_at: "2026-08-05T00:00:01.000Z",
      released_at: null,
    });
    expect(
      taskGraph.acquireLease("leased", "worker", { lease_id: "lease-1" }),
    ).toEqual(firstLease);

    now = new Date("2026-08-05T00:00:02.000Z");
    const recovery = taskGraph.recover();
    expect(recovery.expired_leases).toHaveLength(1);
    expect(recovery.recovered_tasks).toEqual([
      expect.objectContaining({
        id: "leased",
        status: "pending",
        owner: null,
        lease_id: null,
        version: 2,
      }),
    ]);
    expect(taskGraph.getLease("lease-1")?.released_at).toBe(
      "2026-08-05T00:00:02.000Z",
    );

    const secondLease = taskGraph.acquireLease("leased", "worker-2", {
      lease_id: "lease-2",
    });
    expect(secondLease?.lease_id).toBe("lease-2");
    expect(
      taskGraph.releaseLease("lease-2", { owner: "worker-2" })?.released_at,
    ).toBe("2026-08-05T00:00:02.000Z");
    expect(taskGraph.requireTask("leased")).toMatchObject({
      status: "pending",
      owner: null,
      lease_id: null,
      version: 4,
    });
  });

  test("recovery preserves terminal task metadata while clearing an expired lease", () => {
    const now = "2026-08-05T00:00:02.000Z";
    const path = databasePath();
    const taskGraph = graphAt(path);
    taskGraph.create({
      id: "terminal-with-lease",
      status: "completed",
      owner: "historical-worker",
      claimed_at: "2026-08-05T00:00:00.000Z",
      lease_id: "terminal-lease",
    });
    taskGraph.close();

    const database = new Database(path);
    database
      .prepare(
        `INSERT INTO task_leases(
          lease_id, task_id, owner, acquired_at, expires_at, released_at
        ) VALUES (?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        "terminal-lease",
        "terminal-with-lease",
        "historical-worker",
        "2026-08-05T00:00:00.000Z",
        "2026-08-05T00:00:01.000Z",
      );
    database.close();

    const reopened = graphAt(path, { clock: () => new Date(now) });
    expect(reopened.recover()).toMatchObject({
      recovered_tasks: [
        expect.objectContaining({
          id: "terminal-with-lease",
          status: "completed",
          owner: "historical-worker",
          claimed_at: "2026-08-05T00:00:00.000Z",
          lease_id: null,
          version: 1,
        }),
      ],
    });
  });

  test("persists tasks, idempotency, leases, and versions after reopening SQLite", () => {
    const path = databasePath();
    const first = graphAt(path);
    const created = first.create({
      id: "durable",
      idempotency_key: "durable-request",
    });
    const lease = first.acquireLease("durable", "worker", {
      lease_id: "durable-lease",
    });
    first.close();

    const reopened = graphAt(path);
    expect(reopened.read("durable")).toMatchObject({
      ...created,
      status: "claimed",
      owner: "worker",
      claimed_at: expect.any(String),
      lease_id: "durable-lease",
      version: 1,
    });
    expect(
      reopened.create({ id: "new-id", idempotency_key: "durable-request" }),
    ).toMatchObject({
      id: "durable",
    });
    expect(reopened.getLease(lease?.lease_id ?? "")).toMatchObject({
      lease_id: "durable-lease",
      task_id: "durable",
      released_at: null,
    });
  });

  test("returns an immutable, point-in-time graph snapshot", () => {
    const taskGraph = graph();
    taskGraph.create({ id: "snapshot-task", files_touched: ["a.ts"] });
    const snapshot = taskGraph.snapshot();
    taskGraph.update("snapshot-task", { files_touched: ["b.ts"] });

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks)).toBe(true);
    expect(Object.isFrozen(snapshot.tasks[0])).toBe(true);
    expect(snapshot).toEqual({
      version: 1,
      graph_version: 1,
      captured_at: expect.any(String),
      tasks: [
        expect.objectContaining({
          id: "snapshot-task",
          files_touched: ["a.ts"],
        }),
      ],
    } satisfies Partial<TaskGraphSnapshot>);
    expect(() => {
      (snapshot.tasks[0] as { files_touched: string[] }).files_touched.push(
        "mutated.ts",
      );
    }).toThrow();
  });
});
