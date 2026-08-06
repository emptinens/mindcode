import type {
  ColdFallbackDecision,
  WarmAcquireResult,
  WarmWorkerDecision,
  WorkerLease,
  WorkerLeaseReleaseOptions,
  WorkerPoolDecision,
  WorkerPoolOptions,
  WorkerPoolRequest,
  WorkerPoolSnapshot,
  WorkerSlotSnapshot,
} from "./types.js";
import {
  FIXED_WORKER_MODEL,
  WorkerPoolAbortedError,
  WorkerPoolClosedError,
  WorkerPoolIneligibleError,
} from "./types.js";
import { WorkerSlot } from "./workerSlot.js";

type Waiter<T> = {
  request: WorkerPoolRequest;
  decision: WarmWorkerDecision;
  resolve: (lease: WorkerLease<T>) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const MAX_NAMESPACE_LENGTH = 512;

function namespaceFor(
  request: Pick<WorkerPoolRequest, "projectId" | "sessionId">,
): string {
  return `${request.projectId.length}:${request.projectId}${request.sessionId.length}:${request.sessionId}`;
}

function validNamespacePart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_NAMESPACE_LENGTH &&
    !value.includes("\0")
  );
}

function hasWriteOverlap(request: WorkerPoolRequest): boolean {
  return (
    request.writeOverlap === true ||
    request.hasWriteOverlap === true ||
    request.overlap === true
  );
}

function fallback(
  request: WorkerPoolRequest,
  reason: ColdFallbackDecision["reason"],
  namespace?: string,
): ColdFallbackDecision {
  return {
    kind: "fallback",
    mode: "cold",
    isolation: "isolated",
    eligible: false,
    model: FIXED_WORKER_MODEL,
    effort: request.effort ?? "medium",
    reason,
    scheduler: "unchanged",
    ...(namespace === undefined ? {} : { namespace }),
  };
}

function validateLimit(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
  return value;
}

function validateMaxSlots(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError("maxSlots must be a positive integer");
  }
  return value;
}

/**
 * A bounded, namespace-affine pool. It only owns warm-slot state; routing,
 * overlap claims, scheduler leases, and cold execution remain external.
 */
export class WorkerPool<T> {
  private readonly createWorker: () => T | PromiseLike<T>;
  private readonly options: WorkerPoolOptions<T>;
  private readonly maxSlots: number;
  private readonly ttlMs: number | undefined;
  private readonly idleTtlMs: number | undefined;
  private readonly now: () => number;
  private readonly slots = new Map<string, WorkerSlot<T>>();
  private readonly waiters: Waiter<T>[] = [];
  private readonly pendingCreations = new Set<Promise<void>>();
  private readonly pendingDisposals = new Set<Promise<boolean>>();
  private creatingSlots = 0;
  private disposingSlots = 0;
  private nextSlotId = 0;
  private closed = false;
  private draining = false;
  private closePromise?: Promise<void>;

  constructor(options: WorkerPoolOptions<T>) {
    this.options = options;
    this.createWorker =
      options.createWorker ??
      options.factory ??
      options.create ??
      (() => {
        throw new TypeError("WorkerPool requires createWorker or factory");
      });
    this.maxSlots = validateMaxSlots(options.maxSlots);
    this.ttlMs = validateLimit(options.ttlMs, "ttlMs");
    this.idleTtlMs = validateLimit(options.idleTtlMs, "idleTtlMs");
    this.now = options.now ?? Date.now;
  }

  /** Pure routing decision. No slot or scheduler state is changed. */
  decide(request: WorkerPoolRequest): WorkerPoolDecision {
    const namespace =
      validNamespacePart(request.projectId) &&
      validNamespacePart(request.sessionId)
        ? namespaceFor(request)
        : undefined;
    if (namespace === undefined) return fallback(request, "namespace");
    if ((request.model ?? FIXED_WORKER_MODEL) !== FIXED_WORKER_MODEL) {
      return fallback(request, "model", namespace);
    }
    if (
      request.effort !== undefined &&
      request.effort !== "low" &&
      request.effort !== "medium"
    ) {
      return fallback(request, "effort", namespace);
    }
    if (request.isolation === "isolated") {
      return fallback(request, "isolation", namespace);
    }
    if (hasWriteOverlap(request)) {
      return fallback(request, "write-overlap", namespace);
    }
    return {
      kind: "warm",
      mode: "warm",
      eligible: true,
      model: FIXED_WORKER_MODEL,
      effort: (request.effort ?? "medium") as WarmWorkerDecision["effort"],
      namespace,
    };
  }

  async acquire(request: WorkerPoolRequest): Promise<WorkerLease<T>> {
    const decision = this.decide(request);
    if (decision.kind === "fallback")
      throw new WorkerPoolIneligibleError(decision);
    return this.acquireWarm(request, decision);
  }

  async acquireOrFallback(
    request: WorkerPoolRequest,
  ): Promise<WarmAcquireResult<T>> {
    const decision = this.decide(request);
    if (decision.kind === "fallback") return { kind: "fallback", decision };
    return {
      kind: "warm",
      decision,
      lease: await this.acquireWarm(request, decision),
    };
  }

  /**
   * Create or validate an idle warm worker without claiming an external
   * scheduler lease. The normal acquire/release path is used so prewarming
   * also exercises the same reset boundary as a completed task.
   */
  async prewarm(request: WorkerPoolRequest): Promise<boolean> {
    const decision = this.decide(request);
    if (decision.kind === "fallback") return false;
    const lease = await this.acquireWarm(request, decision);
    await lease.release();
    return true;
  }

  /** Evict idle TTL-expired slots and return the number evicted. */
  async evictExpired(at = this.now()): Promise<number> {
    let evicted = 0;
    for (const [id, slot] of this.slots) {
      if (slot.canAcquire() && slot.isExpired(at, this.ttlMs, this.idleTtlMs)) {
        this.slots.delete(id);
        await this.disposeDetached(slot);
        evicted += 1;
      }
    }
    this.drain();
    return evicted;
  }

  /** Deterministic maintenance entry point; equivalent to evictExpired(). */
  async sweep(at = this.now()): Promise<number> {
    return this.evictExpired(at);
  }

  async evictIdle(at = this.now()): Promise<number> {
    return this.evictExpired(at);
  }

  snapshots(): WorkerSlotSnapshot[] {
    return [...this.slots.values()].map((slot) => slot.snapshot());
  }

  snapshot(): WorkerPoolSnapshot {
    let busySlots = 0;
    for (const slot of this.slots.values()) {
      if (!slot.canAcquire()) busySlots += 1;
    }
    return {
      slots: this.slots.size,
      busySlots,
      idleSlots: this.slots.size - busySlots,
      queuedRequests: this.waiters.length,
      creatingSlots: this.creatingSlots,
      disposingSlots: this.disposingSlots,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const error = new WorkerPoolClosedError();
    for (const waiter of this.waiters.splice(0)) {
      this.removeAbortListener(waiter);
      waiter.reject(error);
    }
    const slots = [...this.slots.values()];
    this.slots.clear();
    this.closePromise = this.finishClose(slots);
    return this.closePromise;
  }

  private acquireWarm(
    request: WorkerPoolRequest,
    decision: WarmWorkerDecision,
  ): Promise<WorkerLease<T>> {
    if (this.closed) return Promise.reject(new WorkerPoolClosedError());
    if (request.signal?.aborted)
      return Promise.reject(new WorkerPoolAbortedError());
    void this.evictExpired().catch(() => undefined);
    return new Promise<WorkerLease<T>>((resolve, reject) => {
      const waiter: Waiter<T> = {
        request,
        decision,
        resolve,
        reject,
        signal: request.signal,
      };
      if (request.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index === -1) return;
          this.waiters.splice(index, 1);
          reject(new WorkerPoolAbortedError());
          this.drain();
        };
        request.signal.addEventListener("abort", waiter.onAbort, {
          once: true,
        });
      }
      this.waiters.push(waiter);
      this.drain();
    });
  }

  private drain(): void {
    if (this.draining || this.closed) return;
    this.draining = true;
    try {
      while (this.waiters.length > 0 && !this.closed) {
        const waiter = this.waiters[0];
        if (!waiter) break;
        if (waiter.signal?.aborted) {
          this.waiters.shift();
          this.removeAbortListener(waiter);
          waiter.reject(new WorkerPoolAbortedError());
          continue;
        }
        const existing = this.findIdle(waiter.decision.namespace);
        if (existing) {
          this.waiters.shift();
          this.removeAbortListener(waiter);
          this.giveSlot(existing, waiter);
          continue;
        }
        if (this.occupiedSlots() >= this.maxSlots) {
          const other = this.findIdleOtherThan(waiter.decision.namespace);
          if (!other) break;
          this.slots.delete(other.id);
          void this.disposeDetached(other).catch(() => undefined);
          continue;
        }
        this.waiters.shift();
        this.removeAbortListener(waiter);
        this.creatingSlots += 1;
        const creation = this.createSlot(waiter);
        this.pendingCreations.add(creation);
        void creation
          .finally(() => this.pendingCreations.delete(creation))
          .catch(() => undefined);
      }
    } finally {
      this.draining = false;
    }
  }

  private findIdle(namespace: string): WorkerSlot<T> | undefined {
    for (const slot of this.slots.values()) {
      if (slot.namespace === namespace && slot.canAcquire()) return slot;
    }
    return undefined;
  }

  private findIdleOtherThan(namespace: string): WorkerSlot<T> | undefined {
    for (const slot of this.slots.values()) {
      if (slot.namespace !== namespace && slot.canAcquire()) return slot;
    }
    return undefined;
  }

  private giveSlot(slot: WorkerSlot<T>, waiter: Waiter<T>): void {
    try {
      slot.acquire();
      waiter.resolve(this.lease(slot, waiter.decision));
    } catch (error) {
      this.slots.delete(slot.id);
      void this.disposeDetached(slot).catch(() => undefined);
      waiter.reject(error);
    }
  }

  private async createSlot(waiter: Waiter<T>): Promise<void> {
    try {
      const worker = (await this.createWorker()) as T;
      const slot = new WorkerSlot<T>({
        id: `worker-slot-${this.nextSlotId++}`,
        namespace: waiter.decision.namespace,
        createdAt: this.now(),
        now: this.now,
        worker,
        reset: this.options.reset,
        resetContext: this.options.resetContext,
        resetTools: this.options.resetTools,
        resetPolicy: this.options.resetPolicy,
        destroy: this.options.destroy,
      });
      if (this.closed || waiter.signal?.aborted) {
        await this.disposeDetached(slot);
        waiter.reject(
          this.closed
            ? new WorkerPoolClosedError()
            : new WorkerPoolAbortedError(),
        );
        return;
      }
      this.slots.set(slot.id, slot);
      this.giveSlot(slot, waiter);
    } catch (error) {
      waiter.reject(error);
    } finally {
      this.creatingSlots -= 1;
      this.drain();
    }
  }

  private lease(
    slot: WorkerSlot<T>,
    decision: WarmWorkerDecision,
  ): WorkerLease<T> {
    let released = false;
    const release = async (
      options: WorkerLeaseReleaseOptions = {},
    ): Promise<boolean> => {
      if (released) return false;
      released = true;
      if (options.poisoned) {
        this.slots.delete(slot.id);
        const result = await this.disposeDetached(slot, () => slot.poison());
        this.drain();
        return result;
      }
      try {
        const result = await slot.release();
        if (slot.isExpired(this.now(), this.ttlMs, this.idleTtlMs)) {
          this.slots.delete(slot.id);
          await this.disposeDetached(slot);
        }
        this.drain();
        return result;
      } catch (error) {
        this.slots.delete(slot.id);
        await this.disposeDetached(slot).catch(() => undefined);
        this.drain();
        throw error;
      }
    };
    const poison = async (): Promise<boolean> => {
      if (released) return false;
      released = true;
      this.slots.delete(slot.id);
      const result = await this.disposeDetached(slot, () => slot.poison());
      this.drain();
      return result;
    };
    return {
      worker: slot.worker,
      slotId: slot.id,
      namespace: slot.namespace,
      decision,
      release,
      poison,
    };
  }

  private removeAbortListener(waiter: Waiter<T>): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.onAbort = undefined;
    }
  }

  private occupiedSlots(): number {
    return this.slots.size + this.creatingSlots + this.disposingSlots;
  }

  private disposeDetached(
    slot: WorkerSlot<T>,
    dispose: () => Promise<boolean> = () => slot.dispose(),
  ): Promise<boolean> {
    // Count the physical runtime until its async destroy hook has completed.
    // This prevents namespace replacement from creating a new runtime while
    // the old one is still alive, even when maxSlots is one.
    this.disposingSlots += 1;
    const operation = (async () => {
      try {
        return await dispose();
      } finally {
        this.disposingSlots -= 1;
        this.drain();
      }
    })();
    this.pendingDisposals.add(operation);
    void operation
      .finally(() => this.pendingDisposals.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  private async finishClose(slots: WorkerSlot<T>[]): Promise<void> {
    const errors: unknown[] = [];
    for (const slot of slots) this.disposeDetached(slot).catch(() => undefined);

    while (this.pendingCreations.size > 0 || this.pendingDisposals.size > 0) {
      const pending = [...this.pendingCreations, ...this.pendingDisposals];
      const results = await Promise.allSettled(pending);
      for (const result of results) {
        if (result.status === "rejected") errors.push(result.reason);
      }
    }

    if (errors.length > 0) throw errors[0];
  }
}

export const GenericWorkerPool = WorkerPool;
