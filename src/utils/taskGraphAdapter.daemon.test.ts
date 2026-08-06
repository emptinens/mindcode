import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DaemonDisabledError,
  DaemonRemoteError,
  DaemonTimeoutError,
} from "../runtime/daemon/errors.js";
import { TaskGraphDaemonClient } from "../runtime/taskGraph/client.js";
import type { TaskGraphDaemonTransport } from "../runtime/taskGraph/protocol.js";
import { TaskGraph } from "../tasks/graph/taskGraph.js";
import type { TaskRecord } from "../tasks/graph/types.js";
import {
  graphCreateTask,
  graphGetTask,
  graphUpdateTask,
  setTaskGraphDaemonClientForTests,
} from "./taskGraphAdapter.js";

const originalConfig = process.env.MINDCODE_CONFIG_DIR;
const originalDaemonDisabled = process.env.MINDCODE_DAEMON_DISABLED;
const roots: string[] = [];

function storageId(taskListId: string, taskId: string): string {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  return `mindcode-team-v2:${encode(taskListId)}:${encode(taskId)}`;
}

function makeTask(id: string): TaskRecord {
  return {
    id,
    status: "pending" as const,
    owner: null,
    kind: "implement" as const,
    effort: "medium" as const,
    priority: 0,
    blocked_by: [],
    claimed_at: null,
    started_at: null,
    finished_at: null,
    files_touched: [],
    read_set: [],
    write_set: [],
    isolation: "shared" as const,
    lease_id: null,
    version: 0,
    policy_epoch: 0,
    report_id: null,
  };
}

async function useStore(): Promise<string> {
  const root = await mkdtemp("/tmp/mindcode-task-daemon-");
  roots.push(root);
  process.env.MINDCODE_CONFIG_DIR = root;
  process.env.MINDCODE_DAEMON_DISABLED = undefined;
  return root;
}

function installTransport(transport: TaskGraphDaemonTransport): void {
  setTaskGraphDaemonClientForTests(() => new TaskGraphDaemonClient(transport));
}

afterEach(async () => {
  setTaskGraphDaemonClientForTests(undefined);
  if (originalConfig === undefined) process.env.MINDCODE_CONFIG_DIR = undefined;
  else process.env.MINDCODE_CONFIG_DIR = originalConfig;
  if (originalDaemonDisabled === undefined)
    process.env.MINDCODE_DAEMON_DISABLED = undefined;
  else process.env.MINDCODE_DAEMON_DISABLED = originalDaemonDisabled;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("task graph adapter daemon boundary", () => {
  test("uses daemon responses and does not invoke the local graph", async () => {
    const root = await useStore();
    const taskId = storageId("daemon-team", "1");
    const task = makeTask(taskId);
    const calls: string[] = [];
    installTransport({
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "task_graph.list") return { tasks: [] } as T;
        if (method === "task_graph.route") {
          return {
            task,
            created: true,
            decision: {
              action: "allow",
              allowed: true,
              mode: "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        }
        if (method === "task_graph.read") return { task } as T;
        if (method === "task_graph.list_dependents") return { tasks: [] } as T;
        throw new Error(`unexpected method ${method}`);
      },
    });

    const created = await graphCreateTask("daemon-team", {
      subject: "daemon task",
      description: "authoritative daemon state",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });
    expect(created).toBe("1");
    expect(await graphGetTask("daemon-team", "1")).toMatchObject({
      id: "1",
      subject: "daemon task",
    });
    expect(calls).toEqual([
      "task_graph.list",
      "task_graph.route",
      "task_graph.read",
      "task_graph.list_dependents",
    ]);

    const details = new Database(join(root, "state", "tasks.db"));
    expect(
      details.prepare("SELECT COUNT(*) AS count FROM task_graph_details").get(),
    ).toEqual({ count: 1 });
    expect(
      details
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        )
        .get(),
    ).toEqual({ count: 0 });
    details.close();
  });

  test("falls back only for daemon unavailability and closes the local graph", async () => {
    await useStore();
    const originalClose = TaskGraph.prototype.close;
    let closeCalls = 0;
    TaskGraph.prototype.close = function closeSpy() {
      closeCalls += 1;
      return originalClose.call(this);
    };
    try {
      installTransport({
        async request<T>(): Promise<T> {
          throw new DaemonDisabledError();
        },
      });
      expect(
        await graphCreateTask("fallback-team", {
          subject: "fallback task",
          description: "legacy path",
          status: "pending",
          blocks: [],
          blockedBy: [],
        }),
      ).toBe("1");
      expect(closeCalls).toBe(1);
    } finally {
      TaskGraph.prototype.close = originalClose;
    }
  });

  test("pins daemon authority after the first successful call", async () => {
    await useStore();
    const taskId = storageId("authority-team", "1");
    const task = makeTask(taskId);
    let failMutation = false;
    installTransport({
      async request<T>(method: string): Promise<T> {
        if (method === "task_graph.route")
          return {
            task,
            created: true,
            decision: {
              action: "allow",
              allowed: true,
              mode: "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        if (method === "task_graph.read") return { task } as T;
        if (method === "task_graph.list_dependents") return { tasks: [] } as T;
        if (method === "task_graph.update") {
          if (failMutation) throw new DaemonTimeoutError("connect", 1);
          return { task: { ...task, effort: "high", version: 1 } } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    });
    await graphCreateTask("authority-team", {
      id: "1",
      subject: "Authority",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
    });

    const originalUpdate = TaskGraph.prototype.update;
    let fallbackUpdates = 0;
    TaskGraph.prototype.update = function updateSpy(...args) {
      fallbackUpdates += 1;
      return originalUpdate.apply(this, args);
    };
    try {
      failMutation = true;
      await expect(
        graphUpdateTask("authority-team", "1", { effort: "high" }),
      ).rejects.toMatchObject({ name: "DaemonTimeoutError" });
      expect(fallbackUpdates).toBe(0);
    } finally {
      TaskGraph.prototype.update = originalUpdate;
    }
  });

  test("closes a fallback graph when migration fails after opening it", async () => {
    const root = await useStore();
    await mkdir(join(root, "tasks", "fallback-failure"), { recursive: true });
    await writeFile(
      join(root, "tasks", "fallback-failure", "1.json"),
      JSON.stringify({
        id: "1",
        subject: "Fallback failure",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      }),
    );
    installTransport({
      async request<T>(): Promise<T> {
        throw new DaemonDisabledError();
      },
    });
    const originalRead = TaskGraph.prototype.read;
    const originalClose = TaskGraph.prototype.close;
    let closeCalls = 0;
    TaskGraph.prototype.read = function readFailure() {
      throw new Error("migration failure");
    };
    TaskGraph.prototype.close = function closeSpy() {
      closeCalls += 1;
      return originalClose.call(this);
    };
    try {
      await expect(graphGetTask("fallback-failure", "1")).rejects.toThrow(
        "migration failure",
      );
      expect(closeCalls).toBe(1);
    } finally {
      TaskGraph.prototype.read = originalRead;
      TaskGraph.prototype.close = originalClose;
    }
  });

  test("propagates RPC errors instead of hiding them behind the TypeScript fallback", async () => {
    await useStore();
    let fallbackOpened = false;
    const originalClose = TaskGraph.prototype.close;
    TaskGraph.prototype.close = function closeSpy() {
      fallbackOpened = true;
      return originalClose.call(this);
    };
    try {
      installTransport({
        async request<T>(): Promise<T> {
          throw new DaemonRemoteError("database unavailable", "DATABASE_ERROR");
        },
      });
      await expect(graphGetTask("rpc-team", "1")).rejects.toMatchObject({
        name: "TaskGraphRemoteError",
        remoteCode: "DATABASE_ERROR",
      });
      expect(fallbackOpened).toBe(false);
    } finally {
      TaskGraph.prototype.close = originalClose;
    }
  });

  test("atomically blocks one of two concurrent structural overlaps", async () => {
    await useStore();
    const tasks = new Map<string, TaskRecord>();
    installTransport({
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === "task_graph.list")
          return { tasks: [...tasks.values()] } as T;
        if (method === "task_graph.route") {
          const input = (
            params as { task: { id: string; write_set?: string[] } }
          ).task;
          const task = {
            ...makeTask(input.id),
            status: "running" as const,
            write_set: input.write_set ?? [],
          };
          tasks.set(task.id, task);
          return {
            task,
            created: true,
            decision: {
              action: "allow",
              allowed: true,
              mode: "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        }
        if (method === "task_graph.read") {
          const id = (params as { task_id: string }).task_id;
          return { task: tasks.get(id) ?? null } as T;
        }
        if (method === "task_graph.list_dependents") return { tasks: [] } as T;
        if (method === "task_graph.route_update") {
          await new Promise((resolve) => setTimeout(resolve, 5));
          const request = params as {
            task_id: string;
            patch: { write_set?: string[] };
            mode?: "block" | "reject";
          };
          const current = tasks.get(request.task_id);
          if (!current) throw new Error("missing task");
          const writeSet = request.patch.write_set ?? current.write_set;
          const conflict = [...tasks.values()].find(
            (task) =>
              task.id !== current.id &&
              !["completed", "failed"].includes(task.status) &&
              task.write_set.some((target) => writeSet.includes(target)),
          );
          if (conflict) {
            const blocked = {
              ...current,
              status: "pending" as const,
              owner: null,
              write_set: writeSet,
              blocked_by: [conflict.id],
              version: current.version + 1,
            };
            tasks.set(blocked.id, blocked);
            return {
              task: blocked,
              created: false,
              decision: {
                action: "blocked",
                allowed: true,
                mode: request.mode ?? "block",
                isolation: "shared",
                conflicts: [
                  {
                    task_id: conflict.id,
                    paths: writeSet,
                    kinds: ["write_write"],
                    existing_isolation: "shared",
                    new_isolation: "shared",
                  },
                ],
                blocked_by: [conflict.id],
              },
            } as T;
          }
          const updated = {
            ...current,
            write_set: writeSet,
            version: current.version + 1,
          };
          tasks.set(updated.id, updated);
          return {
            task: updated,
            created: false,
            decision: {
              action: "allow",
              allowed: true,
              mode: request.mode ?? "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        }
        throw new Error(`unexpected method ${method}`);
      },
    });

    await graphCreateTask("concurrent-overlap", {
      id: "a",
      subject: "A",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: { write_set: ["src/other.ts"] },
    });
    await graphCreateTask("concurrent-overlap", {
      id: "b",
      subject: "B",
      description: "",
      status: "pending",
      blocks: [],
      blockedBy: [],
      metadata: { write_set: ["src/initial.ts"] },
    });

    const [first, second] = await Promise.all([
      graphUpdateTask("concurrent-overlap", "a", {
        metadata: { write_set: ["src/shared.ts"] },
        write_set: ["src/shared.ts"],
      }),
      graphUpdateTask("concurrent-overlap", "b", {
        metadata: { write_set: ["src/shared.ts"] },
        write_set: ["src/shared.ts"],
      }),
    ]);
    expect(
      [first?.status, second?.status].filter((status) => status === "pending"),
    ).toHaveLength(1);
    expect(
      [...tasks.values()].filter(
        (task) =>
          task.status === "running" &&
          task.write_set.some((target) => target.endsWith("/src/shared.ts")),
      ),
    ).toHaveLength(1);
  });

  test("imports legacy JSON through daemon route/read RPCs before serving the adapter", async () => {
    const root = await useStore();
    await mkdir(join(root, "tasks", "daemon-legacy"), { recursive: true });
    await writeFile(
      join(root, "tasks", "daemon-legacy", "7.json"),
      JSON.stringify({
        id: "7",
        subject: "Legacy daemon task",
        description: "Imported through RPC",
        status: "pending",
        blocks: [],
        blockedBy: [],
        metadata: { effort: "high" },
      }),
    );
    const taskId = storageId("daemon-legacy", "7");
    const task = makeTask(taskId);
    const calls: string[] = [];
    installTransport({
      async request<T>(method: string): Promise<T> {
        calls.push(method);
        if (method === "task_graph.read")
          return { task: calls.length === 1 ? null : task } as T;
        if (method === "task_graph.route") {
          return {
            task,
            created: true,
            decision: {
              action: "allow",
              allowed: true,
              mode: "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        }
        if (method === "task_graph.list_dependents") return { tasks: [] } as T;
        throw new Error(`unexpected method ${method}`);
      },
    });

    await expect(graphGetTask("daemon-legacy", "7")).resolves.toMatchObject({
      id: "7",
      subject: "Legacy daemon task",
      metadata: { effort: "high" },
    });
    expect(calls).toEqual([
      "task_graph.read",
      "task_graph.route",
      "task_graph.read",
      "task_graph.read",
      "task_graph.list_dependents",
    ]);
    const details = new Database(join(root, "state", "tasks.db"));
    expect(
      details
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'tasks'",
        )
        .get(),
    ).toEqual({ count: 0 });
    details.close();
  });

  test("propagates migration dependency errors and leaves the marker unset", async () => {
    const root = await useStore();
    await mkdir(join(root, "tasks", "migration-errors"), { recursive: true });
    for (const id of ["a", "b"]) {
      await writeFile(
        join(root, "tasks", "migration-errors", `${id}.json`),
        JSON.stringify({
          id,
          subject: id,
          description: "",
          status: "pending",
          blocks: [id === "a" ? "b" : "a"],
          blockedBy: [],
        }),
      );
    }
    const tasks = new Map<string, TaskRecord>();
    installTransport({
      async request<T>(method: string, params?: unknown): Promise<T> {
        if (method === "task_graph.read") {
          const id = (params as { task_id: string }).task_id;
          return { task: tasks.get(id) ?? null } as T;
        }
        if (method === "task_graph.route") {
          const id = (params as { task: { id: string } }).task.id;
          const routedTask = makeTask(id);
          tasks.set(id, routedTask);
          return {
            task: routedTask,
            created: true,
            decision: {
              action: "allow",
              allowed: true,
              mode: "block",
              isolation: "shared",
              conflicts: [],
              blocked_by: [],
            },
          } as T;
        }
        if (method === "task_graph.route_update")
          throw new DaemonRemoteError(
            "dependency cycle",
            "DEPENDENCY_CYCLE",
          );
        throw new Error(`unexpected method ${method}`);
      },
    });

    await expect(graphGetTask("migration-errors", "a")).rejects.toMatchObject({
      name: "TaskGraphRemoteError",
      remoteCode: "DEPENDENCY_CYCLE",
    });
    const details = new Database(join(root, "state", "tasks.db"));
    expect(
      details
        .prepare(
          "SELECT COUNT(*) AS count FROM task_graph_bridge_meta WHERE key = ?",
        )
        .get("legacy-v2:migration-errors"),
    ).toEqual({ count: 0 });
    details.close();
  });
});
