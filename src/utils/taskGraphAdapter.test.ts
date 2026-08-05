import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TaskGraph, openTaskGraph } from "../tasks/graph/taskGraph.js";
import { graphGetTask, graphUpdateTask } from "./taskGraphAdapter.js";
import {
  claimTask,
  createTask,
  getTask,
  getTasksDir,
  listTasks,
  updateTask,
} from "./tasks.js";

const roots: string[] = [];
const originalConfig = process.env.MINDCODE_CONFIG_DIR;

afterEach(async () => {
  if (originalConfig === undefined) process.env.MINDCODE_CONFIG_DIR = undefined;
  else process.env.MINDCODE_CONFIG_DIR = originalConfig;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function useStore(): Promise<string> {
  const root = await mkdtemp("/tmp/mindcode-task-bridge-");
  roots.push(root);
  process.env.MINDCODE_CONFIG_DIR = root;
  return root;
}

describe("SQLite task tool bridge", () => {
  test("uses graph status/targets and stores UI metadata beside the graph", async () => {
    await useStore();
    const id = await createTask("team-a", {
      subject: "Implement bridge",
      description: "Use one SQLite source",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: {
        effort: "high",
        files_touched: ["src/shared.ts"],
        read_set: ["src/input.ts"],
        write_set: ["src/shared.ts"],
        isolation: "shared",
      },
    });

    const graph = openTaskGraph();
    const stored = graph.list()[0];
    expect(stored).toMatchObject({
      status: "pending",
      isolation: "shared",
    });
    expect(stored?.id).not.toBe(id);
    expect(stored?.files_touched[0]).toEndWith("/src/shared.ts");
    expect(stored?.read_set[0]).toEndWith("/src/input.ts");
    expect(stored?.write_set[0]).toEndWith("/src/shared.ts");
    graph.close();

    const running = await updateTask("team-a", id, {
      status: "running",
      owner: "worker-a",
    });
    expect(running).toMatchObject({ id, status: "running", owner: "worker-a" });
    expect(running?.metadata?.effort).toBe("high");
    expect((await listTasks("team-a")).map((task) => task.id)).toEqual([id]);
  });

  test("persists task graph fields independently of UI metadata", async () => {
    await useStore();
    const id = await createTask("schema-team", {
      subject: "Schema task",
      description: "full fields",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: {
        kind: "verify",
        effort: "xhigh",
        priority: 8,
        policy_epoch: 11,
        report_id: "report-1",
        custom: "retained",
      },
    });

    expect(await graphGetTask("schema-team", id)).toMatchObject({
      id,
      kind: "verify",
      effort: "xhigh",
      priority: 8,
      policy_epoch: 11,
      report_id: "report-1",
      started_at: null,
      finished_at: null,
      metadata: { custom: "retained" },
    });

    const updated = await graphUpdateTask("schema-team", id, {
      effort: "none",
      priority: 2,
      report_id: "report-2",
      policy_epoch: 12,
    });
    expect(updated).toMatchObject({
      effort: "none",
      priority: 2,
      report_id: "report-2",
      policy_epoch: 12,
    });
  });

  test("get and update use targeted graph reads rather than full-list scans", async () => {
    await useStore();
    const id = await createTask("targeted-team", {
      subject: "Targeted",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const originalList = TaskGraph.prototype.list;
    TaskGraph.prototype.list = (() => {
      throw new Error("full graph list must not be used by get/update");
    }) as typeof TaskGraph.prototype.list;
    try {
      expect((await graphGetTask("targeted-team", id))?.id).toBe(id);
      expect(
        (await graphUpdateTask("targeted-team", id, { effort: "high" }))
          ?.effort,
      ).toBe("high");
    } finally {
      TaskGraph.prototype.list = originalList;
    }
  });

  test("blocks claims on incomplete dependencies and routes target overlap", async () => {
    await useStore();
    const dependency = await createTask("team-b", {
      subject: "Dependency",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: { write_set: ["src/shared.ts"] },
    });
    const dependent = await createTask("team-b", {
      subject: "Dependent",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [dependency],
      metadata: { read_set: ["src/shared.ts"] },
    });

    const blocked = await claimTask("team-b", dependent, "worker-b");
    expect(blocked).toMatchObject({ success: false, reason: "blocked" });

    await updateTask("team-b", dependency, { status: "completed" });
    const claimed = await claimTask("team-b", dependent, "worker-b");
    expect(claimed).toMatchObject({
      success: true,
      task: { status: "claimed" },
    });
  });

  test("atomic CAS permits exactly one concurrent claimant", async () => {
    await useStore();
    const id = await createTask("team-c", {
      subject: "Race",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    const results = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        claimTask("team-c", id, `worker-${index}`),
      ),
    );
    expect(results.filter((result) => result.success)).toHaveLength(1);
    expect((await getTask("team-c", id))?.status).toBe("claimed");
  });

  test("isolates identical public IDs, claims, dependencies, and overlap by task list", async () => {
    await useStore();
    const [teamAFirst, teamBFirst] = await Promise.all([
      createTask("team-a", {
        subject: "Team A writer",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: { write_set: ["src/same.ts"] },
      }),
      createTask("team-b", {
        subject: "Team B writer",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: { write_set: ["src/same.ts"] },
      }),
    ]);
    const teamASecond = await createTask("team-a", {
      subject: "Team A conflicting reader",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: { read_set: ["src/same.ts"] },
    });

    expect(teamAFirst).toBe("1");
    expect(teamBFirst).toBe("1");
    expect(teamASecond).toBe("2");
    expect((await listTasks("team-a")).map((task) => task.subject)).toEqual([
      "Team A writer",
      "Team A conflicting reader",
    ]);
    expect((await listTasks("team-b")).map((task) => task.subject)).toEqual([
      "Team B writer",
    ]);
    expect((await getTask("team-a", "2"))?.blockedBy).toEqual(["1"]);
    expect((await getTask("team-b", "1"))?.blockedBy).toEqual([]);

    const [teamAClaim, teamBClaim] = await Promise.all([
      claimTask("team-a", "1", "worker-a"),
      claimTask("team-b", "1", "worker-b"),
    ]);
    expect(teamAClaim).toMatchObject({ success: true });
    expect(teamBClaim).toMatchObject({ success: true });
    expect((await getTask("team-a", "1"))?.owner).toBe("worker-a");
    expect((await getTask("team-b", "1"))?.owner).toBe("worker-b");
  });

  test("migrates raw bridge rows to a namespace without losing UI metadata", async () => {
    const root = await useStore();
    const graph = openTaskGraph();
    graph.route({ id: "9", write_set: ["src/raw.ts"] });
    expect(graph.tryClaim("9", "legacy-worker").ok).toBe(true);
    graph.close();

    const database = new Database(join(root, "state", "tasks.db"));
    database.exec(`
      CREATE TABLE task_graph_details (
        task_id TEXT PRIMARY KEY NOT NULL,
        task_list_id TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT NOT NULL,
        active_form TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `);
    database
      .prepare(`
        INSERT INTO task_graph_details(
          task_id, task_list_id, subject, description, active_form, metadata, deleted
        ) VALUES (?, ?, ?, ?, ?, ?, 0)
      `)
      .run(
        "9",
        "raw-team",
        "Raw bridge task",
        "Preserve me",
        "Migrating task",
        JSON.stringify({ effort: "high", custom: { keep: true } }),
      );
    database.close();

    expect(await getTask("raw-team", "9")).toMatchObject({
      id: "9",
      subject: "Raw bridge task",
      description: "Preserve me",
      activeForm: "Migrating task",
      status: "claimed",
      owner: "legacy-worker",
      metadata: { effort: "high", custom: { keep: true } },
    });
    const migratedGraph = openTaskGraph();
    expect(migratedGraph.read("9")).toBeNull();
    const migratedRecord = migratedGraph.list()[0];
    expect(migratedRecord?.id).not.toBe("9");
    expect(migratedRecord?.write_set[0]).toEndWith("/src/raw.ts");
    expect(migratedGraph.getTaskLease(migratedRecord?.id ?? "")).not.toBeNull();
    migratedGraph.close();
  });

  test("imports legacy JSON once, then reads the graph as the authority", async () => {
    await useStore();
    const dir = getTasksDir("legacy-team");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "7.json"),
      JSON.stringify({
        id: "7",
        subject: "Legacy task",
        description: "Imported",
        status: "in_progress",
        blocks: [],
        blockedBy: [],
        metadata: { effort: "medium", write_set: ["src/legacy.ts"] },
      }),
    );
    expect(await getTask("legacy-team", "7")).toMatchObject({
      id: "7",
      subject: "Legacy task",
      status: "pending",
    });
    const graph = openTaskGraph();
    expect(graph.list()[0]?.write_set[0]).toEndWith("/src/legacy.ts");
    graph.close();
  });
});
