import { afterEach, describe, expect, test } from "bun:test";
import {
  FIXED_WORKER_MODEL,
  WorkerPool,
  WorkerPoolAbortedError,
  WorkerPoolClosedError,
  WorkerPoolIneligibleError,
} from "./index.js";

const pools: Array<WorkerPool<{ id: number }>> = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.close()));
});

function pool(
  options: Partial<
    ConstructorParameters<typeof WorkerPool<{ id: number }>>[0]
  > = {},
): WorkerPool<{ id: number }> {
  let nextId = 0;
  const value = new WorkerPool<{ id: number }>({
    maxSlots: 2,
    createWorker: () => ({ id: nextId++ }),
    ...options,
  });
  pools.push(value);
  return value;
}

const request = (sessionId: string, extra: Record<string, unknown> = {}) => ({
  projectId: "project-a",
  sessionId,
  effort: "medium",
  ...extra,
});

describe("generic warm worker pool", () => {
  test("reuses a warm worker inside one session namespace", async () => {
    const workers = pool();
    const first = await workers.acquire(request("session-a"));
    await first.release();
    const second = await workers.acquire(request("session-a"));

    expect(second.worker).toBe(first.worker);
    expect(second.slotId).toBe(first.slotId);
    expect(workers.snapshot()).toMatchObject({ slots: 1, busySlots: 1 });
    await second.release();
  });

  test("keeps session namespaces isolated even in one project pool", async () => {
    const workers = pool({ maxSlots: 2 });
    const first = await workers.acquire(request("session-a"));
    const second = await workers.acquire(request("session-b"));

    expect(second.worker).not.toBe(first.worker);
    expect(second.namespace).not.toBe(first.namespace);
    await first.release();
    await second.release();
  });

  test("evicts slots by deterministic idle TTL and absolute TTL", async () => {
    let now = 100;
    const workers = pool({ now: () => now, idleTtlMs: 10, ttlMs: 100 });
    const first = await workers.acquire(request("session-a"));
    await first.release();
    now = 110;
    expect(await workers.sweep()).toBe(1);
    expect(workers.snapshot().slots).toBe(0);

    const replacement = await workers.acquire(request("session-a"));
    await replacement.release();
    now = 200;
    expect(await workers.sweep()).toBe(1);
    expect(workers.snapshot().slots).toBe(0);
  });

  test("removes an aborted queued acquisition without consuming a slot", async () => {
    const workers = pool({ maxSlots: 1 });
    const active = await workers.acquire(request("session-a"));
    const controller = new AbortController();
    const waiting = workers.acquire({
      ...request("session-b"),
      signal: controller.signal,
    });
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(WorkerPoolAbortedError);
    expect(workers.snapshot()).toMatchObject({
      slots: 1,
      busySlots: 1,
      queuedRequests: 0,
    });
    await active.release();
  });

  test("evicts a poisoned slot and creates a replacement", async () => {
    const workers = pool();
    const first = await workers.acquire(request("session-a"));
    const slotId = first.slotId;
    await expect(first.poison(new Error("worker failed"))).resolves.toBe(true);
    expect(workers.snapshot().slots).toBe(0);

    const second = await workers.acquire(request("session-a"));
    expect(second.slotId).not.toBe(slotId);
    await second.release();
  });

  test("poisons a slot when context/tool/policy reset fails", async () => {
    const resetCalls: string[] = [];
    let failPolicyReset = false;
    const workers = new WorkerPool<{ id: number }>({
      maxSlots: 1,
      createWorker: () => ({ id: 1 }),
      resetContext: () => {
        resetCalls.push("context");
      },
      resetTools: () => {
        resetCalls.push("tools");
      },
      resetPolicy: () => {
        resetCalls.push("policy");
        if (failPolicyReset) throw new Error("policy reset failed");
      },
    });
    pools.push(workers);
    const first = await workers.acquire(request("session-a"));
    await first.release();
    failPolicyReset = true;
    const lease = await workers.acquire(request("session-a"));

    await expect(lease.release()).rejects.toThrow("reset failed");
    expect(resetCalls).toEqual([
      "context",
      "tools",
      "policy",
      "context",
      "tools",
      "policy",
    ]);
    expect(workers.snapshot().slots).toBe(0);
  });

  test("resets after the first task and after every subsequent task", async () => {
    const resetCalls: number[] = [];
    const workers = pool({
      reset: (worker) => {
        resetCalls.push(worker.id);
      },
    });
    const first = await workers.acquire(request("session-a"));
    await first.release();
    expect(resetCalls).toEqual([0]);

    const second = await workers.acquire(request("session-a"));
    await second.release();
    expect(resetCalls).toEqual([0, 0]);
  });

  test("returns a cold isolated fallback without touching pool capacity", async () => {
    const workers = pool();
    const decisions = [
      workers.decide(request("session-a", { model: "other" })),
      workers.decide(request("session-a", { effort: "high" })),
      workers.decide(request("session-a", { effort: "xhigh" })),
      workers.decide(request("session-a", { effort: "max" })),
      workers.decide(request("session-a", { writeOverlap: true })),
    ];

    expect(decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "cold",
          isolation: "isolated",
          scheduler: "unchanged",
          model: FIXED_WORKER_MODEL,
        }),
      ]),
    );
    for (const decision of decisions) expect(decision.kind).toBe("fallback");
    await expect(
      workers.acquire(request("session-a", { effort: "high" })),
    ).rejects.toBeInstanceOf(WorkerPoolIneligibleError);
    expect(workers.snapshot()).toMatchObject({ slots: 0, queuedRequests: 0 });
  });

  test("bounds capacity while allowing a waiting namespace after release", async () => {
    const workers = pool({ maxSlots: 1 });
    const first = await workers.acquire(request("session-a"));
    const waiting = workers.acquire(request("session-b"));
    expect(workers.snapshot()).toMatchObject({
      slots: 1,
      busySlots: 1,
      queuedRequests: 1,
    });

    await first.release();
    const second = await waiting;
    expect(second.namespace).not.toBe(first.namespace);
    expect(second.worker).not.toBe(first.worker);
    await second.release();
    expect(workers.snapshot()).toMatchObject({
      slots: 1,
      busySlots: 0,
      queuedRequests: 0,
    });
  });

  test("uses the fixed worker model for eligible decisions", () => {
    const workers = pool();
    expect(workers.decide(request("session-a"))).toMatchObject({
      kind: "warm",
      model: FIXED_WORKER_MODEL,
      effort: "medium",
    });
  });

  test("prewarms an eligible namespace without retaining a lease", async () => {
    const workers = pool();

    await expect(workers.prewarm(request("session-a"))).resolves.toBe(true);
    expect(workers.snapshot()).toMatchObject({
      slots: 1,
      busySlots: 0,
      queuedRequests: 0,
    });

    const lease = await workers.acquire(request("session-a"));
    expect(lease.worker.id).toBe(0);
    await lease.release();
    await expect(
      workers.prewarm(request("session-b", { model: "other" })),
    ).resolves.toBe(false);
    expect(workers.snapshot().slots).toBe(1);
  });

  test("waits for async namespace destruction before creating a replacement", async () => {
    let resolveDestroy: (() => void) | undefined;
    let liveWorkers = 0;
    let maximumLiveWorkers = 0;
    const destroyFinished = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const workers = pool({
      maxSlots: 1,
      createWorker: () => {
        liveWorkers += 1;
        maximumLiveWorkers = Math.max(maximumLiveWorkers, liveWorkers);
        return { id: liveWorkers };
      },
      destroy: async () => {
        await destroyFinished;
        liveWorkers -= 1;
      },
    });
    const first = await workers.acquire(request("session-a"));
    await first.release();

    const replacement = workers.acquire(request("session-b"));
    await Promise.resolve();
    expect(workers.snapshot()).toMatchObject({
      slots: 0,
      busySlots: 0,
      queuedRequests: 1,
      disposingSlots: 1,
      creatingSlots: 0,
    });
    expect(maximumLiveWorkers).toBe(1);

    resolveDestroy?.();
    const second = await replacement;
    expect(maximumLiveWorkers).toBe(1);
    await second.release();
  });

  test("counts an asynchronously evicted runtime until destruction finishes", async () => {
    let now = 0;
    let liveWorkers = 0;
    let maximumLiveWorkers = 0;
    let resolveDestroy!: () => void;
    const destroyFinished = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const workers = pool({
      maxSlots: 1,
      idleTtlMs: 1,
      now: () => now,
      createWorker: () => {
        liveWorkers += 1;
        maximumLiveWorkers = Math.max(maximumLiveWorkers, liveWorkers);
        return { id: liveWorkers };
      },
      destroy: async () => {
        await destroyFinished;
        liveWorkers -= 1;
      },
    });
    const first = await workers.acquire(request("session-a"));
    await first.release();
    now = 1;

    const sweep = workers.sweep();
    await Promise.resolve();
    const replacement = workers.acquire(request("session-a"));
    await Promise.resolve();
    expect(workers.snapshot()).toMatchObject({
      slots: 0,
      disposingSlots: 1,
      queuedRequests: 1,
    });
    expect(maximumLiveWorkers).toBe(1);

    resolveDestroy();
    await sweep;
    const second = await replacement;
    expect(maximumLiveWorkers).toBe(1);
    await second.release();
  });

  test("close waits for in-flight creation and destroys the late worker", async () => {
    let resolveCreate!: (worker: { id: number }) => void;
    const created = new Promise<{ id: number }>((resolve) => {
      resolveCreate = resolve;
    });
    const destroyed: number[] = [];
    const workers = pool({
      maxSlots: 1,
      createWorker: () => created,
      destroy: (worker) => {
        destroyed.push(worker.id);
      },
    });
    const acquisition = workers.acquire(request("session-a"));
    await Promise.resolve();

    let closeSettled = false;
    const closing = workers.close().then(() => {
      closeSettled = true;
    });
    await Promise.resolve();
    expect(closeSettled).toBe(false);

    resolveCreate({ id: 42 });
    await expect(acquisition).rejects.toBeInstanceOf(WorkerPoolClosedError);
    await closing;
    expect(destroyed).toEqual([42]);
    expect(workers.snapshot()).toMatchObject({
      slots: 0,
      creatingSlots: 0,
      disposingSlots: 0,
      queuedRequests: 0,
    });
  });

  test("concurrent close calls await the same in-flight destruction", async () => {
    let resolveDestroy!: () => void;
    const destroyFinished = new Promise<void>((resolve) => {
      resolveDestroy = resolve;
    });
    const workers = pool({
      maxSlots: 1,
      destroy: () => destroyFinished,
    });
    const lease = await workers.acquire(request("session-a"));
    await lease.release();

    const first = workers.close();
    const second = workers.close();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    resolveDestroy();
    await Promise.all([first, second]);
    expect(workers.snapshot().disposingSlots).toBe(0);
  });
});
