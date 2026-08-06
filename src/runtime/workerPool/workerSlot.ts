import type {
  Awaitable,
  WorkerResetHooks,
  WorkerSlotSnapshot,
  WorkerSlotState,
} from "./types.js";
import { WorkerPoolSlotError } from "./types.js";

export type WorkerSlotOptions<T> = WorkerResetHooks<T> & {
  id: string;
  namespace: string;
  createdAt: number;
  now: () => number;
  worker: T;
};

/** One namespace-affine worker. A slot is never rebound to another session. */
export class WorkerSlot<T> {
  readonly id: string;
  readonly namespace: string;
  readonly createdAt: number;

  private readonly now: () => number;
  private readonly resetHook?: (worker: T) => Awaitable<void>;
  private readonly resetContext?: (worker: T) => Awaitable<void>;
  private readonly resetTools?: (worker: T) => Awaitable<void>;
  private readonly resetPolicy?: (worker: T) => Awaitable<void>;
  private readonly destroyHook?: (worker: T) => Awaitable<void>;
  private readonly workerValue: T;
  private stateValue: WorkerSlotState = "idle";
  private lastUsedAtValue: number;

  constructor(options: WorkerSlotOptions<T>) {
    this.id = options.id;
    this.namespace = options.namespace;
    this.createdAt = options.createdAt;
    this.lastUsedAtValue = options.createdAt;
    this.now = options.now;
    this.workerValue = options.worker;
    this.resetHook = options.reset;
    this.resetContext = options.resetContext;
    this.resetTools = options.resetTools;
    this.resetPolicy = options.resetPolicy;
    this.destroyHook = options.destroy;
  }

  get worker(): T {
    return this.workerValue;
  }

  get state(): WorkerSlotState {
    return this.stateValue;
  }

  get lastUsedAt(): number {
    return this.lastUsedAtValue;
  }

  snapshot(): WorkerSlotSnapshot {
    return {
      id: this.id,
      namespace: this.namespace,
      state: this.stateValue,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAtValue,
    };
  }

  canAcquire(): boolean {
    return this.stateValue === "idle";
  }

  acquire(): T {
    if (!this.canAcquire()) {
      throw new WorkerPoolSlotError(`Worker slot ${this.id} is not idle`);
    }
    this.stateValue = "busy";
    return this.workerValue;
  }

  async release(): Promise<boolean> {
    if (this.stateValue === "disposed") return false;
    if (this.stateValue !== "busy") return false;

    try {
      // Every completed task must leave the worker in a clean baseline. This
      // also applies to the first task, before the slot has ever been reused.
      await this.reset();
    } catch (error) {
      this.stateValue = "poisoned";
      await this.dispose();
      throw new WorkerPoolSlotError(
        `Worker slot ${this.id} reset failed and was evicted`,
        error,
      );
    }

    this.lastUsedAtValue = this.now();
    this.stateValue = "idle";
    return true;
  }

  async poison(): Promise<boolean> {
    if (this.stateValue === "disposed") return false;
    this.stateValue = "poisoned";
    await this.dispose();
    return true;
  }

  isExpired(now: number, ttlMs?: number, idleTtlMs?: number): boolean {
    const ttlExpired = ttlMs !== undefined && now - this.createdAt >= ttlMs;
    const idleExpired =
      idleTtlMs !== undefined && now - this.lastUsedAtValue >= idleTtlMs;
    return ttlExpired || idleExpired;
  }

  async dispose(): Promise<boolean> {
    if (this.stateValue === "disposed") return false;
    this.stateValue = "disposed";
    if (this.destroyHook) await this.destroyHook(this.workerValue);
    return true;
  }

  private async reset(): Promise<void> {
    if (this.resetHook) await this.resetHook(this.workerValue);
    if (this.resetContext) await this.resetContext(this.workerValue);
    if (this.resetTools) await this.resetTools(this.workerValue);
    if (this.resetPolicy) await this.resetPolicy(this.workerValue);
  }
}
