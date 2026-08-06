import { describe, expect, test } from "bun:test";
import type { TaskRecord } from "../../tasks/graph/types.js";
import { DaemonDisconnectedError } from "../daemon/errors.js";
import type { DaemonRequestOptions } from "../daemon/types.js";
import { TaskGraphDaemonClient } from "../taskGraph/client.js";
import type { TaskGraphWatchChunk } from "../taskGraph/protocol.js";
import {
  StreamingDagCoordinator,
  type StreamingDagSnapshot,
  StreamingDagWatchBridge,
} from "./index.js";

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
  files_touched: ["src/task.ts"],
  read_set: [],
  write_set: ["src/task.ts"],
  isolation: "shared",
  lease_id: null,
  version: 0,
  policy_epoch: 0,
  report_id: null,
};

function chunk(
  kind: TaskGraphWatchChunk["kind"],
  version: number,
  graphVersion = version,
): TaskGraphWatchChunk {
  const snapshot = {
    version,
    graph_version: graphVersion,
    captured_at: "2026-08-06T00:00:00.000Z",
    tasks: version >= 1 ? [task] : [],
  };
  return {
    schema_version: 1,
    kind,
    graph_version: graphVersion,
    snapshot,
  };
}

function coordinator(
  calls: string[],
): StreamingDagCoordinator<TaskRecord, string> {
  return new StreamingDagCoordinator({
    executor: (currentTask) => {
      calls.push(currentTask.id);
      return "done";
    },
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function clientFrom(
  request: (
    options: DaemonRequestOptions | undefined,
    params: unknown,
  ) => Promise<unknown>,
): TaskGraphDaemonClient {
  return new TaskGraphDaemonClient({
    request<T>(
      _method: string,
      params?: unknown,
      options?: DaemonRequestOptions,
    ) {
      return request(options, params) as Promise<T>;
    },
  });
}

describe("StreamingDagWatchBridge", () => {
  test("applies the initial snapshot and reconnects changed/resync snapshots once", async () => {
    const calls: string[] = [];
    let watchCount = 0;
    const client = clientFrom(async (options) => {
      watchCount += 1;
      if (watchCount === 1) {
        await options?.onChunk?.(chunk("snapshot", 1), 0);
        await options?.onChunk?.(chunk("changed", 2), 1);
        await options?.onChunk?.(chunk("changed", 2), 2);
        return { reason: "idle_timeout", last_version: 2 };
      }
      await options?.onChunk?.(chunk("resync", 3), 0);
      return { reason: "idle_timeout", last_version: 3 };
    });
    const dag = coordinator(calls);
    const bridge = new StreamingDagWatchBridge({
      client,
      coordinator: dag,
      idleRestartDelayMs: 1,
    });

    const completion = bridge.start();
    await flush();
    bridge.stop();
    await completion;

    expect(watchCount).toBe(1);
    expect(dag.getState()).toMatchObject({
      phase: "ready",
      sequence: 2,
      graphVersion: 2,
    });
    expect(calls).toEqual(["task-1"]);
  });

  test("restarts idle timeout with the authoritative after_version without a busy loop", async () => {
    const params: unknown[] = [];
    let watchCount = 0;
    let markSecondWatchStarted: (() => void) | undefined;
    const secondWatchStarted = new Promise<void>((resolve) => {
      markSecondWatchStarted = resolve;
    });
    const client = clientFrom(async (options, requestParams) => {
      params.push(requestParams);
      watchCount += 1;
      if (watchCount === 1) {
        await options?.onChunk?.(chunk("snapshot", 4), 0);
        return { reason: "idle_timeout", last_version: 4 };
      }
      if (watchCount === 2) {
        markSecondWatchStarted?.();
        return { reason: "idle_timeout", last_version: 4 };
      }
      throw new Error("stop");
    });
    const dag = coordinator([]);
    const bridge = new StreamingDagWatchBridge({
      client,
      coordinator: dag,
      idleRestartDelayMs: 5,
      maxRetries: 0,
    });

    const completion = bridge.start();
    await secondWatchStarted;
    bridge.stop();
    await completion;

    expect(watchCount).toBeLessThanOrEqual(2);
    expect(params[1]).toMatchObject({ after_version: 4 });
  });

  test("cancels the current watch with AbortSignal", async () => {
    const controller = new AbortController();
    let aborted = false;
    const client = clientFrom(
      (_options, _params) =>
        new Promise((_, reject) => {
          controller.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DaemonDisconnectedError());
            },
            { once: true },
          );
        }),
    );
    const dag = coordinator([]);
    const bridge = new StreamingDagWatchBridge({
      client,
      coordinator: dag,
      signal: controller.signal,
    });

    const completion = bridge.start();
    await Promise.resolve();
    controller.abort("cancel");
    await completion;

    expect(aborted).toBe(true);
    expect(bridge.state.stopped).toBe(true);
  });

  test("uses bounded exponential retry and prevents task creation while disconnected", async () => {
    const calls: unknown[] = [];
    let attempts = 0;
    const client = clientFrom(async (_options, params) => {
      calls.push(params);
      attempts += 1;
      throw new DaemonDisconnectedError();
    });
    const dag = coordinator([]);
    const retries: Array<[number, number]> = [];
    const bridge = new StreamingDagWatchBridge({
      client,
      coordinator: dag,
      maxRetries: 2,
      retryBaseMs: 1,
      retryMaxMs: 2,
      onRetry: (attempt, delay) => retries.push([attempt, delay]),
    });

    await expect(bridge.start()).rejects.toBeInstanceOf(
      DaemonDisconnectedError,
    );
    expect(attempts).toBe(3);
    expect(retries).toEqual([
      [1, 1],
      [2, 2],
    ]);
    expect(dag.getState().leaderConnected).toBe(false);
    expect(() =>
      dag.createTask({
        id: "new",
        dependencies: [],
        payload: { ...task, id: "new" },
      }),
    ).toThrow("leader is disconnected");
    expect(calls).toHaveLength(3);
  });

  test("maps daemon payloads through the adapter without retaining stream data", async () => {
    const bridgeRef: { value?: StreamingDagWatchBridge<string, string> } = {};
    const client = clientFrom(async (options) => {
      await options?.onChunk?.(chunk("snapshot", 1), 0);
      bridgeRef.value?.stop();
      return { reason: "idle_timeout", last_version: 1 };
    });
    const seen: string[] = [];
    const dag = new StreamingDagCoordinator<string, string>({
      executor: (currentTask) => {
        seen.push(currentTask.payload);
        return "done";
      },
    });
    bridgeRef.value = new StreamingDagWatchBridge({
      client,
      coordinator: dag,
      payload: (record) => record.id,
    });

    await bridgeRef.value.start();
    await flush();
    expect(seen).toEqual(["task-1"]);
  });
});
