import { describe, expect, test } from "bun:test";
import type { TaskGraphSnapshot, TaskRecord } from "../../tasks/graph/types.js";
import { DaemonCancelledError } from "../daemon/errors.js";
import type { DaemonRequestOptions } from "../daemon/types.js";
import { TaskGraphDaemonClient } from "./client.js";
import { TaskGraphProtocolError } from "./errors.js";
import type {
  TaskGraphDaemonTransport,
  TaskGraphWatchChunk,
} from "./protocol.js";
import { streamTaskGraph } from "./stream.js";

const task: TaskRecord = {
  id: "watch-task",
  status: "pending",
  owner: null,
  kind: "implement",
  effort: "medium",
  priority: 0,
  blocked_by: [],
  claimed_at: null,
  started_at: null,
  finished_at: null,
  files_touched: ["src/watch.ts"],
  read_set: [],
  write_set: ["src/watch.ts"],
  isolation: "shared",
  lease_id: null,
  version: 0,
  policy_epoch: 0,
  report_id: null,
};

const snapshot: TaskGraphSnapshot = {
  version: 1,
  graph_version: 1,
  captured_at: "2026-08-06T00:00:00.000Z",
  tasks: [task],
};

const chunk: TaskGraphWatchChunk = {
  schema_version: 1,
  kind: "snapshot",
  graph_version: 1,
  snapshot,
};

describe("TaskGraphDaemonClient watch", () => {
  test("validates stream chunks and terminal result", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = new TaskGraphDaemonClient({
      async request<T>(
        method: string,
        params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        calls.push({ method, params });
        await options?.onChunk?.(chunk, 0);
        return { reason: "idle_timeout", last_version: 1 } as T;
      },
    });
    const events: unknown[] = [];
    const result = await client.watch(
      { after_version: 0, poll_interval_ms: 10, idle_timeout_ms: 100 },
      (event) => {
        events.push(event);
      },
    );

    expect(calls).toEqual([
      {
        method: "task_graph.watch",
        params: {
          after_version: 0,
          poll_interval_ms: 10,
          idle_timeout_ms: 100,
        },
      },
    ]);
    expect(events).toEqual([{ ...chunk, sequence: 0 }]);
    expect(result).toEqual({ reason: "idle_timeout", last_version: 1 });
  });

  test("rejects malformed chunks and out-of-range parameters", async () => {
    const malformed = new TaskGraphDaemonClient({
      async request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        await options?.onChunk?.(
          { ...chunk, graph_version: 2, unexpected: "secret" },
          0,
        );
        return { reason: "idle_timeout", last_version: 1 } as T;
      },
    });
    await expect(malformed.watch({}, () => undefined)).rejects.toBeInstanceOf(
      TaskGraphProtocolError,
    );

    const unreachable: TaskGraphDaemonTransport = {
      async request<T>(): Promise<T> {
        throw new Error("request must not be dispatched");
      },
    };
    const client = new TaskGraphDaemonClient(unreachable);
    await expect(
      client.watch({ poll_interval_ms: 9 }, () => undefined),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.watch({ idle_timeout_ms: 120_001 }, () => undefined),
    ).rejects.toBeInstanceOf(TypeError);
    await expect(
      client.watch(
        { after_version: Number.MAX_SAFE_INTEGER + 1 },
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  test("serializes async event handlers before resolving the watch", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const client = new TaskGraphDaemonClient({
      async request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        void options?.onChunk?.(chunk, 0);
        void options?.onChunk?.(
          {
            ...chunk,
            kind: "changed",
            graph_version: 2,
            snapshot: nextSnapshot(),
          },
          1,
        );
        return { reason: "idle_timeout", last_version: 2 } as T;
      },
    });
    const order: number[] = [];
    let settled = false;
    const watched = client
      .watch({}, async (event) => {
        if (event.sequence === 0) await firstBlocked;
        order.push(event.sequence);
      })
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    releaseFirst();
    await watched;
    expect(order).toEqual([0, 1]);
  });
});

describe("TaskGraphWatchStream", () => {
  test("exposes validated events and completion as a bounded async stream", async () => {
    const client = new TaskGraphDaemonClient({
      async request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        await options?.onChunk?.(chunk, 0);
        await options?.onChunk?.(
          {
            ...chunk,
            kind: "changed",
            graph_version: 2,
            snapshot: nextSnapshot(),
          },
          1,
        );
        return { reason: "idle_timeout", last_version: 2 } as T;
      },
    });
    const stream = streamTaskGraph(client, {}, { maxBufferedEvents: 2 });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map(({ kind, sequence }) => ({ kind, sequence }))).toEqual([
      { kind: "snapshot", sequence: 0 },
      { kind: "changed", sequence: 1 },
    ]);
    expect(await stream.completion).toEqual({
      reason: "idle_timeout",
      last_version: 2,
    });
  });

  test("cancels the daemon request when iteration returns", async () => {
    let dispatched = false;
    const client = new TaskGraphDaemonClient({
      request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        dispatched = true;
        return new Promise<T>((_resolve, reject) => {
          options?.signal?.addEventListener(
            "abort",
            () => reject(new DaemonCancelledError()),
            { once: true },
          );
        });
      },
    });
    const stream = streamTaskGraph(client);
    await Promise.resolve();
    expect(dispatched).toBe(true);
    await stream.return();
    await expect(stream.completion).rejects.toBeInstanceOf(
      DaemonCancelledError,
    );
    expect(await stream.next()).toEqual({ done: true, value: undefined });
  });

  test("fails instead of growing an unbounded event queue", async () => {
    const client = new TaskGraphDaemonClient({
      async request<T>(
        _method: string,
        _params?: unknown,
        options?: DaemonRequestOptions,
      ): Promise<T> {
        await options?.onChunk?.(chunk, 0);
        await options?.onChunk?.(
          {
            ...chunk,
            kind: "changed",
            graph_version: 2,
            snapshot: nextSnapshot(),
          },
          1,
        );
        return { reason: "idle_timeout", last_version: 2 } as T;
      },
    });
    const stream = streamTaskGraph(client, {}, { maxBufferedEvents: 1 });
    await expect(stream.completion).rejects.toBeInstanceOf(
      TaskGraphProtocolError,
    );
    expect((await stream.next()).value.sequence).toBe(0);
    await expect(stream.next()).rejects.toBeInstanceOf(TaskGraphProtocolError);
  });
});

function nextSnapshot(): TaskGraphSnapshot {
  return { ...snapshot, version: 2, graph_version: 2 };
}
