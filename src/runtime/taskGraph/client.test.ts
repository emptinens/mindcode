import { describe, expect, test } from "bun:test";
import type {
  ClaimResult,
  RecoveryResult,
  RouteResult,
  TaskGraphSnapshot,
  TaskLease,
  TaskRecord,
} from "../../tasks/graph/types.js";
import {
  DaemonCancelledError,
  DaemonClientError,
  DaemonDisabledError,
  DaemonDisconnectedError,
  DaemonRemoteError,
  DaemonTimeoutError,
} from "../daemon/errors.js";
import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { TaskGraphDaemonClient } from "./client.js";
import { TaskGraphProtocolError, type TaskGraphRemoteError } from "./errors.js";
import type { TaskGraphDaemonTransport } from "./protocol.js";

const task: TaskRecord = {
  id: "task-1",
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
  read_set: [],
  write_set: ["src/a.ts"],
  isolation: "shared",
  lease_id: null,
  version: 0,
  policy_epoch: 0,
  report_id: null,
};

const lease: TaskLease = {
  lease_id: "lease-1",
  task_id: "task-1",
  owner: "luna-1",
  acquired_at: "2026-08-06T00:00:00.000Z",
  expires_at: "2026-08-06T00:01:00.000Z",
  released_at: null,
};

const decision = {
  action: "allow" as const,
  allowed: true,
  mode: "block" as const,
  isolation: "shared" as const,
  conflicts: [],
  blocked_by: [],
};

const route: RouteResult = { task, created: true, decision };
const claim: ClaimResult = { ok: true, task, lease };
const recovery: RecoveryResult = {
  expired_leases: [],
  recovered_tasks: [],
  leases: [lease],
  tasks: [task],
};
const snapshot: TaskGraphSnapshot = {
  version: 1,
  graph_version: 1,
  captured_at: "2026-08-06T00:00:00.000Z",
  tasks: [task],
};

function fakeTransport(
  responseByMethod: Record<string, unknown> = {},
): TaskGraphDaemonTransport & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request<T>(method: string, params?: unknown) {
      calls.push({ method, params });
      return responseByMethod[method] as T;
    },
  };
}

describe("TaskGraphDaemonClient wire boundary", () => {
  test("uses exact RPC methods and parameter shapes", async () => {
    const transport = fakeTransport({
      "task_graph.route": route,
      "task_graph.read": { task },
      "task_graph.list": { tasks: [task] },
      "task_graph.list_dependents": { tasks: [task] },
      "task_graph.claim": claim,
      "task_graph.update": { task },
      "task_graph.renew_lease": { lease },
      "task_graph.release_lease": { lease },
      "task_graph.recover": recovery,
      "task_graph.snapshot": snapshot,
    });
    const client = new TaskGraphDaemonClient(transport);

    await client.route({ id: "task-1", files_touched: ["src/a.ts"] }, "reject");
    await client.read("task-1");
    await client.list({ status: "pending", owner: null, limit: 10, offset: 2 });
    await client.listDependents("task-1");
    await client.claim({
      task_id: "task-1",
      owner: "luna-1",
      ttl_ms: 1000,
      now: new Date("2026-08-06T00:00:00.000Z"),
    });
    await client.update("task-1", { status: "running" }, 0);
    await client.renewLease("lease-1", {
      owner: "luna-1",
      ttl_ms: 1000,
      now: "2026-08-06T00:00:00.000Z",
    });
    await client.releaseLease("lease-1", {
      owner: "luna-1",
      now: "2026-08-06T00:00:00.000Z",
    });
    await client.recover("2026-08-06T00:00:00.000Z");
    await client.snapshot();

    expect(transport.calls).toEqual([
      {
        method: "task_graph.route",
        params: {
          task: { id: "task-1", files_touched: ["src/a.ts"] },
          mode: "reject",
        },
      },
      { method: "task_graph.read", params: { task_id: "task-1" } },
      {
        method: "task_graph.list",
        params: { status: "pending", owner: null, limit: 10, offset: 2 },
      },
      {
        method: "task_graph.list_dependents",
        params: { task_id: "task-1" },
      },
      {
        method: "task_graph.claim",
        params: {
          task_id: "task-1",
          owner: "luna-1",
          ttl_ms: 1000,
          now: "2026-08-06T00:00:00.000Z",
        },
      },
      {
        method: "task_graph.update",
        params: {
          task_id: "task-1",
          patch: { status: "running" },
          expected_version: 0,
        },
      },
      {
        method: "task_graph.renew_lease",
        params: {
          lease_id: "lease-1",
          owner: "luna-1",
          ttl_ms: 1000,
          now: "2026-08-06T00:00:00.000Z",
        },
      },
      {
        method: "task_graph.release_lease",
        params: {
          lease_id: "lease-1",
          owner: "luna-1",
          now: "2026-08-06T00:00:00.000Z",
        },
      },
      {
        method: "task_graph.recover",
        params: { now: "2026-08-06T00:00:00.000Z" },
      },
      { method: "task_graph.snapshot", params: {} },
    ]);
  });

  test("rejects malformed daemon payloads without exposing request data", async () => {
    const secret = "forge-test-secret";
    const path = "/private/secret/tasks.db";
    const transport = fakeTransport({
      "task_graph.read": { task: { id: secret, path } },
    });
    const client = new TaskGraphDaemonClient(transport);

    await expect(client.read("task-1")).rejects.toBeInstanceOf(
      TaskGraphProtocolError,
    );
    try {
      await client.read("task-1");
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).not.toContain(path);
    }
  });

  test("runs manager fallback callback exactly once when disabled", async () => {
    let fallbackCalls = 0;
    const transport: TaskGraphDaemonTransport = {
      async requestWithFallback<T>(
        _method: string,
        _params: unknown,
        fallback: T | (() => T | Promise<T>),
        _options?: DaemonRequestOptions,
      ): Promise<DaemonCallResult<T>> {
        const error = new DaemonDisabledError();
        const value =
          typeof fallback === "function"
            ? await (fallback as () => T | Promise<T>)()
            : fallback;
        return {
          source: "fallback",
          value: value as T,
          reason: "disabled",
          error,
        };
      },
    };
    const client = new TaskGraphDaemonClient(transport);
    const result = await client.snapshotWithFallback(async () => {
      fallbackCalls += 1;
      return snapshot;
    });
    expect(result.source).toBe("fallback");
    expect(fallbackCalls).toBe(1);
  });

  test("runs direct read fallback once on unavailable but preserves abort", async () => {
    let fallbackCalls = 0;
    const transport: TaskGraphDaemonTransport = {
      async request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ) {
        if (options?.signal?.aborted) throw new DaemonCancelledError();
        throw new DaemonDisconnectedError();
      },
    };
    const client = new TaskGraphDaemonClient(transport);
    const result = await client.readWithFallback("task-1", () => {
      fallbackCalls += 1;
      return { task: null };
    });
    expect(result.source).toBe("fallback");
    expect(fallbackCalls).toBe(1);

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.readWithFallback(
        "task-1",
        () => {
          fallbackCalls += 1;
          return { task: null };
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(DaemonCancelledError);
    expect(fallbackCalls).toBe(1);
  });

  test("does not hide read-side remote or protocol errors with fallback", async () => {
    for (const failure of [
      new DaemonRemoteError("database failed", "DATABASE_ERROR"),
      new TaskGraphProtocolError("malformed response"),
    ]) {
      let fallbackCalls = 0;
      const client = new TaskGraphDaemonClient({
        async request<T>(): Promise<T> {
          throw failure;
        },
      });
      await expect(
        client.readWithFallback("task-1", () => {
          fallbackCalls += 1;
          return { task: null };
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(fallbackCalls).toBe(0);
    }

    let fallbackCalls = 0;
    const programmingFailureClient = new TaskGraphDaemonClient({
      async request<T>(): Promise<T> {
        throw new Error("programming failure");
      },
    });
    await expect(
      programmingFailureClient.readWithFallback("task-1", () => {
        fallbackCalls += 1;
        return { task: null };
      }),
    ).rejects.toThrow("programming failure");
    expect(fallbackCalls).toBe(0);
  });

  test("does not run mutation fallbacks after semantic, timeout, protocol, or disconnect errors", async () => {
    const failures = [
      new DaemonRemoteError("version conflict", "VERSION_CONFLICT"),
      new DaemonTimeoutError("request", 10),
      new TaskGraphProtocolError("malformed response"),
      new DaemonDisconnectedError(),
      new Error("unknown socket failure"),
    ];
    for (const failure of failures) {
      let fallbackCalls = 0;
      const client = new TaskGraphDaemonClient({
        async request<T>(): Promise<T> {
          throw failure;
        },
      });
      await expect(
        client.updateWithFallback("task-1", { status: "running" }, () => {
          fallbackCalls += 1;
          return { task };
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(fallbackCalls).toBe(0);
    }
  });

  test("allows mutation fallback for pre-dispatch connect and handshake timeouts only", async () => {
    for (const kind of ["connect", "handshake"] as const) {
      let fallbackCalls = 0;
      const client = new TaskGraphDaemonClient({
        async request<T>(): Promise<T> {
          throw new DaemonTimeoutError(kind, 10);
        },
      });
      const result = await client.updateWithFallback(
        "task-1",
        { status: "running" },
        () => {
          fallbackCalls += 1;
          return { task };
        },
      );
      expect(result.source).toBe("fallback");
      expect(fallbackCalls).toBe(1);
    }
  });

  test("maps remote mutation errors to stable graph codes and allows pre-dispatch fallback", async () => {
    const remoteClient = new TaskGraphDaemonClient({
      async request<T>(): Promise<T> {
        throw new DaemonRemoteError("not found", "TASK_NOT_FOUND");
      },
    });
    await expect(
      remoteClient.updateWithFallback("task-1", { status: "running" }, () => ({
        task,
      })),
    ).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    } satisfies Partial<TaskGraphRemoteError>);

    let fallbackCalls = 0;
    const unavailableClient = new TaskGraphDaemonClient({
      async request<T>(): Promise<T> {
        throw new DaemonClientError(
          "DAEMON_REQUEST_UNAVAILABLE",
          "not dispatched",
        );
      },
    });
    const result = await unavailableClient.updateWithFallback(
      "task-1",
      { status: "running" },
      () => {
        fallbackCalls += 1;
        return { task };
      },
    );
    expect(result.source).toBe("fallback");
    expect(fallbackCalls).toBe(1);
  });
});

describe("TaskGraphDaemonClient structural route update", () => {
  test("uses atomic route_update RPC and preserves the decision", async () => {
    const transport = fakeTransport({ "task_graph.route_update": route });
    const client = new TaskGraphDaemonClient(transport);
    const result = await client.routeUpdate({
      task_id: task.id,
      patch: { write_set: [".mindcode-task-scope/team/src/a.ts"] },
      mode: "block",
      expected_version: 0,
    });
    expect(result).toEqual(route);
    expect(transport.calls).toEqual([
      {
        method: "task_graph.route_update",
        params: {
          task_id: task.id,
          patch: { write_set: [".mindcode-task-scope/team/src/a.ts"] },
          mode: "block",
          expected_version: 0,
        },
      },
    ]);
  });
});
