import { describe, expect, test } from "bun:test";
import {
  STREAMING_DAG_DAEMON_SCHEMA_VERSION,
  StreamingDagCoordinator,
  StreamingDagError,
  type StreamingDagSnapshot,
  type StreamingDagSnapshotTask,
  type StreamingDagTask,
  normalizeDaemonSnapshot,
  normalizeDaemonWatchChunk,
} from "./index.js";

type Payload = {
  label: string;
  wait?: "manual";
  fail?: boolean;
};

type Result = string;

function task(
  id: string,
  dependencies: readonly string[] = [],
  payload: Partial<Payload> = {},
): StreamingDagTask<Payload> {
  return {
    id,
    dependencies,
    payload: { label: id, ...payload },
  };
}

function snapshot(
  tasks: readonly StreamingDagSnapshotTask<Payload, Result>[],
  sequence = 0,
  graphVersion = 1,
): StreamingDagSnapshot<Payload, Result> {
  return { sequence, graphVersion, tasks };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("streaming DAG coordinator", () => {
  test("dispatches parallel branches once and releases their join", async () => {
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: async (currentTask) => {
        calls.push(currentTask.id);
        return `${currentTask.id}:done`;
      },
    });

    const applied = coordinator.applySnapshot(
      snapshot([task("left"), task("right"), task("join", ["left", "right"])]),
    );

    expect(applied).toEqual({
      kind: "applied",
      sequence: 0,
      scheduled: ["left", "right"],
    });
    expect(calls).toEqual(["left", "right"]);
    await flush();

    expect(calls).toEqual(["left", "right", "join"]);
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "left", status: "succeeded", result: "left:done" },
      { id: "right", status: "succeeded", result: "right:done" },
      { id: "join", status: "succeeded", result: "join:done" },
    ]);
  });

  test("releases a dependency only after its executor completes", async () => {
    const root = deferred<Result>();
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) => {
        calls.push(currentTask.id);
        return currentTask.id === "root" ? root.promise : "child:done";
      },
    });

    expect(
      coordinator.applySnapshot(
        snapshot([task("root"), task("child", ["root"])]),
      ),
    ).toMatchObject({ scheduled: ["root"] });
    await flush();
    expect(calls).toEqual(["root"]);
    expect(coordinator.getState().tasks[1]).toMatchObject({
      id: "child",
      status: "pending",
    });

    root.resolve("root:done");
    await flush();

    expect(calls).toEqual(["root", "child"]);
    expect(
      coordinator
        .getState()
        .tasks.find((currentTask) => currentTask.id === "child"),
    ).toMatchObject({ status: "succeeded", result: "child:done" });
  });

  test("applies ordered task-creation events and schedules newly released work", async () => {
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) => {
        calls.push(currentTask.id);
        return `${currentTask.id}:done`;
      },
    });
    coordinator.applySnapshot(snapshot([], 0));

    expect(
      coordinator.applyEvent({
        kind: "task_created",
        sequence: 1,
        task: task("root"),
      }),
    ).toMatchObject({ kind: "applied", scheduled: ["root"] });
    await flush();

    expect(
      coordinator.applyEvent({
        kind: "task_created",
        sequence: 2,
        task: task("child", ["root"]),
      }),
    ).toMatchObject({ kind: "applied", scheduled: ["child"] });
    await flush();

    expect(calls).toEqual(["root", "child"]);
    expect(coordinator.getState().sequence).toBe(2);
  });

  test("propagates executor failure and blocks every descendant", async () => {
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: async (currentTask) => {
        calls.push(currentTask.id);
        if (currentTask.id === "bad") throw new Error("boom");
        return `${currentTask.id}:done`;
      },
    });

    coordinator.applySnapshot(
      snapshot([
        task("bad", [], { fail: true }),
        task("dependent", ["bad"]),
        task("grandchild", ["dependent"]),
        task("independent"),
      ]),
    );
    await flush();

    expect(calls).toEqual(["bad", "independent"]);
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "bad", status: "failed" },
      { id: "dependent", status: "blocked" },
      { id: "grandchild", status: "blocked" },
      { id: "independent", status: "succeeded" },
    ]);
  });

  test("requires resync for both a sequence gap and a duplicate", () => {
    const resyncs: unknown[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: () => "done",
      onResyncRequired: (result) => resyncs.push(result),
    });
    coordinator.applySnapshot(snapshot([], 10));

    const gap = coordinator.applyEvent({
      kind: "task_created",
      sequence: 12,
      task: task("gap"),
    });
    expect(gap).toEqual({
      kind: "resync_required",
      reason: "gap",
      expectedSequence: 11,
      receivedSequence: 12,
    });
    expect(coordinator.getState().tasks).toHaveLength(0);

    expect(
      coordinator.applyEvent({
        kind: "task_created",
        sequence: 11,
        task: task("ignored"),
      }),
    ).toMatchObject({ kind: "resync_required", reason: "already_required" });

    coordinator.reconnect(snapshot([], 12, 2));
    const duplicate = coordinator.applyEvent({
      kind: "task_created",
      sequence: 12,
      task: task("duplicate"),
    });
    expect(duplicate).toEqual({
      kind: "resync_required",
      reason: "duplicate",
      expectedSequence: 13,
      receivedSequence: 12,
    });
    expect(resyncs).toHaveLength(2);
  });

  test("validates DAG shape and keeps a monotonic snapshot sequence", () => {
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: () => "done",
    });
    expect(() =>
      coordinator.applySnapshot(snapshot([task("a", ["b"]), task("b", ["a"])])),
    ).toThrow("dependency cycle");

    coordinator.applySnapshot(snapshot([], 5, 3));
    expect(() => coordinator.reconnect(snapshot([], 4, 4))).toThrow(
      "monotonic",
    );
    expect(coordinator.getState()).toMatchObject({
      phase: "ready",
      sequence: 5,
      graphVersion: 3,
    });
  });

  test("reconnects from a snapshot without redispatching an active task", async () => {
    const root = deferred<Result>();
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) => {
        calls.push(currentTask.id);
        return currentTask.id === "root" ? root.promise : "child:done";
      },
    });
    coordinator.applySnapshot(snapshot([task("root")], 0));
    await flush();

    expect(
      coordinator.applyEvent({
        kind: "task_created",
        sequence: 2,
        task: task("never-applied"),
      }),
    ).toMatchObject({ kind: "resync_required", reason: "gap" });

    const reconnected = coordinator.reconnect(
      snapshot([task("root"), task("child", ["root"])], 2, 2),
    );
    expect(reconnected).toMatchObject({ kind: "applied", scheduled: [] });
    expect(coordinator.getState().phase).toBe("ready");

    root.resolve("root:done");
    await flush();

    expect(calls).toEqual(["root", "child"]);
  });

  test("aborts active work and cancels unscheduled work", async () => {
    const controller = new AbortController();
    const aborted: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      signal: controller.signal,
      executor: (currentTask, context) =>
        new Promise<Result>((resolve, reject) => {
          if (context.signal.aborted) {
            aborted.push(currentTask.id);
            reject(context.signal.reason);
            return;
          }
          context.signal.addEventListener(
            "abort",
            () => {
              aborted.push(currentTask.id);
              reject(context.signal.reason);
            },
            { once: true },
          );
          void resolve;
        }),
    });
    coordinator.applySnapshot(
      snapshot([task("active"), task("waiting", ["active"])]),
    );
    await flush();

    controller.abort("stop");
    await flush();

    expect(aborted).toEqual(["active"]);
    expect(coordinator.getState()).toMatchObject({ phase: "cancelled" });
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "active", status: "cancelled", error: "stop" },
      { id: "waiting", status: "cancelled", error: "stop" },
    ]);
  });

  test("continues validated work while disconnected and rejects new task creation", async () => {
    const root = deferred<Result>();
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) => {
        calls.push(currentTask.id);
        return currentTask.id === "root" ? root.promise : "child:done";
      },
    });
    coordinator.applySnapshot(
      snapshot([task("root"), task("child", ["root"])]),
    );
    await flush();
    coordinator.disconnectLeader();

    expect(() => coordinator.createTask(task("new"))).toThrow(
      new StreamingDagError(
        "LEADER_DISCONNECTED",
        "New task creation is disabled while the leader is disconnected",
      ),
    );
    expect(
      coordinator.applyEvent({
        kind: "task_created",
        sequence: 1,
        task: task("event-new"),
      }),
    ).toEqual({ kind: "rejected", reason: "leader_disconnected" });

    root.resolve("root:done");
    await flush();

    expect(calls).toEqual(["root", "child"]);
    expect(coordinator.getState().leaderConnected).toBe(false);
  });

  test("accepts external completion and failure events while the leader is disconnected", async () => {
    const root = deferred<Result>();
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) =>
        currentTask.id === "root" ? root.promise : `${currentTask.id}:done`,
    });
    coordinator.applySnapshot(
      snapshot([task("root"), task("child", ["root"])]),
    );
    await flush();
    coordinator.disconnectLeader();

    expect(
      coordinator.applyEvent({
        kind: "task_succeeded",
        sequence: 1,
        taskId: "root",
        result: "remote:done",
      }),
    ).toMatchObject({ kind: "applied", scheduled: ["child"] });
    await flush();

    expect(coordinator.getState().tasks).toMatchObject([
      { id: "root", status: "succeeded", result: "remote:done" },
      { id: "child", status: "succeeded" },
    ]);
    root.resolve("late-local-result");
  });

  test("accepts an external failure event for a known task while disconnected", () => {
    const pending = deferred<Result>();
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (_currentTask, context) => {
        context.signal.addEventListener(
          "abort",
          () => pending.reject("aborted"),
          {
            once: true,
          },
        );
        return pending.promise;
      },
    });
    coordinator.applySnapshot(snapshot([task("bad")]));
    coordinator.disconnectLeader();

    expect(
      coordinator.applyEvent({
        kind: "task_failed",
        sequence: 1,
        taskId: "bad",
        error: "remote failure",
      }),
    ).toMatchObject({ kind: "applied", scheduled: [] });
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "bad", status: "failed", error: "remote failure" },
    ]);
  });

  test("keeps terminal task events monotonic and does not release blocked dependents", async () => {
    const pending = deferred<Result>();
    const calls: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask) => {
        calls.push(currentTask.id);
        return pending.promise;
      },
    });
    coordinator.applySnapshot(
      snapshot([task("root"), task("child", ["root"])]),
    );
    await flush();

    expect(
      coordinator.applyEvent({
        kind: "task_failed",
        sequence: 1,
        taskId: "root",
        error: new Error("first failure"),
      }),
    ).toMatchObject({ kind: "applied", scheduled: [] });
    expect(
      coordinator.applyEvent({
        kind: "task_failed",
        sequence: 2,
        taskId: "root",
        error: new Error("replacement failure"),
      }),
    ).toMatchObject({ kind: "applied", scheduled: [] });
    expect(
      coordinator.applyEvent({
        kind: "task_succeeded",
        sequence: 3,
        taskId: "root",
        result: "late-success",
      }),
    ).toMatchObject({ kind: "applied", scheduled: [] });
    expect(
      coordinator.applyEvent({
        kind: "task_cancelled",
        sequence: 4,
        taskId: "root",
        reason: "late-cancellation",
      }),
    ).toMatchObject({ kind: "applied", scheduled: [] });

    expect(calls).toEqual(["root"]);
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "root", status: "failed", error: "first failure" },
      { id: "child", status: "blocked" },
    ]);
    pending.resolve("late-local-result");
    await flush();
    expect(coordinator.getState().tasks).toMatchObject([
      { id: "root", status: "failed", error: "first failure" },
      { id: "child", status: "blocked" },
    ]);
  });

  test("stores bounded sanitized strings for external errors and cancellation reasons", async () => {
    const providerPayload = {
      request: { apiKey: "secret", prompt: "private prompt" },
      response: { body: "private response" },
    };
    const fromSnapshot = new StreamingDagCoordinator<Payload, Result>({
      executor: () => "done",
    });
    fromSnapshot.applySnapshot(
      snapshot([
        {
          ...task("snapshot"),
          status: "failed",
          error: providerPayload,
        },
      ]),
    );

    const fromExecutor = new StreamingDagCoordinator<Payload, Result>({
      executor: async () => {
        throw providerPayload;
      },
    });
    fromExecutor.applySnapshot(snapshot([task("executor")]));
    await flush();

    const fromLongReason = new StreamingDagCoordinator<Payload, Result>({
      executor: () => new Promise<Result>(() => {}),
    });
    fromLongReason.applySnapshot(snapshot([task("long")]));
    fromLongReason.applyEvent({
      kind: "task_failed",
      sequence: 1,
      taskId: "long",
      error: "x".repeat(4096),
    });

    const abortReasons: unknown[] = [];
    const fromCancellation = new StreamingDagCoordinator<Payload, Result>({
      executor: (_currentTask, context) => {
        context.signal.addEventListener("abort", () => {
          abortReasons.push(context.signal.reason);
        });
        return new Promise<Result>(() => {});
      },
    });
    fromCancellation.applySnapshot(snapshot([task("active")]));
    fromCancellation.cancel(providerPayload);

    const errors = [
      fromSnapshot.getState().tasks[0]?.error,
      fromExecutor.getState().tasks[0]?.error,
      fromCancellation.getState().tasks[0]?.error,
    ];
    expect(errors).toEqual(["Task failed", "Task failed", "Cancelled"]);
    for (const error of errors) {
      expect(typeof error).toBe("string");
      expect((error as string).length).toBeLessThanOrEqual(512);
      expect(error).not.toBe(providerPayload);
    }
    expect(abortReasons).toEqual(["Cancelled"]);
    expect(fromLongReason.getState().tasks[0]?.error).toEqual(
      `${"x".repeat(511)}…`,
    );
  });

  test("treats reconnect snapshots as authoritative for terminal and missing dispatched tasks", async () => {
    const first = deferred<Result>();
    const aborted: string[] = [];
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: (currentTask, context) => {
        context.signal.addEventListener(
          "abort",
          () => aborted.push(currentTask.id),
          { once: true },
        );
        return currentTask.id === "first" ? first.promise : "done";
      },
    });
    coordinator.applySnapshot(snapshot([task("first"), task("stale")]));
    await flush();

    const reconnected = coordinator.reconnect(
      snapshot(
        [
          {
            ...task("first"),
            status: "succeeded",
            result: "authoritative",
          },
        ],
        1,
        2,
      ),
    );
    expect(reconnected).toMatchObject({ kind: "applied", scheduled: [] });
    expect(coordinator.getState().tasks).toEqual([
      {
        id: "first",
        dependencies: [],
        payload: { label: "first" },
        status: "succeeded",
        result: "authoritative",
      },
    ]);
    expect(aborted).toEqual(["first"]);

    first.resolve("late-local-result");
    await flush();
    expect(coordinator.getState().tasks[0]).toMatchObject({
      status: "succeeded",
      result: "authoritative",
    });
  });

  test("enforces task, identifier, dependency, and total-edge limits", () => {
    const limits = {
      maxTasks: 2,
      maxTaskIdLength: 4,
      maxDependenciesPerTask: 1,
      maxTotalDependencies: 1,
    };
    const coordinator = new StreamingDagCoordinator<Payload, Result>({
      executor: () => "done",
      limits,
    });

    expect(() => coordinator.applySnapshot(snapshot([task("12345")]))).toThrow(
      "length limit",
    );
    expect(() =>
      coordinator.applySnapshot(snapshot([task("a", ["b", "c"])])),
    ).toThrow("dependency limit");
    expect(() =>
      coordinator.applySnapshot(snapshot([task("a"), task("b"), task("c")], 0)),
    ).toThrow("task count");
    const edgeLimitedCoordinator = new StreamingDagCoordinator<Payload, Result>(
      {
        executor: () => "done",
        limits: { ...limits, maxTasks: 3 },
      },
    );
    expect(() =>
      edgeLimitedCoordinator.applySnapshot(
        snapshot([task("a"), task("b", ["a"]), task("c", ["a"])]),
      ),
    ).toThrow("total dependencies");
  });

  test("normalizes daemon snapshots and watch chunks into coordinator schema", () => {
    const daemonSnapshot = {
      version: 7,
      graph_version: 3,
      captured_at: "2026-08-06T00:00:00Z",
      tasks: [
        {
          id: "root",
          status: "completed" as const,
          blocked_by: [],
          payload: "root",
        },
        {
          id: "child",
          status: "pending" as const,
          blocked_by: ["root"],
          payload: "child",
        },
      ],
    };
    expect(normalizeDaemonSnapshot(daemonSnapshot)).toEqual({
      sequence: 7,
      graphVersion: 3,
      tasks: [
        {
          id: "root",
          dependencies: [],
          payload: daemonSnapshot.tasks[0],
          status: "succeeded",
        },
        {
          id: "child",
          dependencies: ["root"],
          payload: daemonSnapshot.tasks[1],
          status: "pending",
        },
      ],
    });
    expect(
      normalizeDaemonWatchChunk({
        schema_version: STREAMING_DAG_DAEMON_SCHEMA_VERSION,
        kind: "changed",
        graph_version: 3,
        snapshot: daemonSnapshot,
      }),
    ).toMatchObject({ kind: "changed", graphVersion: 3 });
  });
});
