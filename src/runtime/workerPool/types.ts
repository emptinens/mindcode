export const FIXED_WORKER_MODEL = "gpt-5.6-luna" as const;

export const WORKER_EFFORTS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type WorkerEffort = (typeof WORKER_EFFORTS)[number];
export type WarmWorkerEffort = "low" | "medium";

export type WorkerPoolRequest = {
  projectId: string;
  sessionId: string;
  model?: string;
  effort?: string;
  /** The scheduler has already determined that another task writes the same target. */
  writeOverlap?: boolean;
  /** Compatibility spelling for callers carrying an overlap guard result. */
  hasWriteOverlap?: boolean;
  overlap?: boolean;
  /** A preselected isolated route cannot use a warm in-process worker. */
  isolation?: "shared" | "isolated";
  signal?: AbortSignal;
};

export type WarmWorkerDecision = {
  kind: "warm";
  mode: "warm";
  eligible: true;
  model: typeof FIXED_WORKER_MODEL;
  effort: WarmWorkerEffort;
  namespace: string;
};

export type ColdFallbackReason =
  | "model"
  | "effort"
  | "write-overlap"
  | "isolation"
  | "namespace";

export type ColdFallbackDecision = {
  kind: "fallback";
  mode: "cold";
  isolation: "isolated";
  eligible: false;
  model: string;
  effort: string;
  reason: ColdFallbackReason;
  /** The pool never claims or releases scheduler authority for this route. */
  scheduler: "unchanged";
  namespace?: string;
};

export type WorkerPoolDecision = WarmWorkerDecision | ColdFallbackDecision;

export type Awaitable<T> = T | PromiseLike<T>;

export type WorkerResetHooks<T> = {
  reset?: (worker: T) => Awaitable<void>;
  resetContext?: (worker: T) => Awaitable<void>;
  resetTools?: (worker: T) => Awaitable<void>;
  resetPolicy?: (worker: T) => Awaitable<void>;
  destroy?: (worker: T) => Awaitable<void>;
};

export type WorkerPoolOptions<T> = WorkerResetHooks<T> & {
  createWorker?: () => Awaitable<T>;
  /** Alias retained so a factory can be passed without adapting its name. */
  factory?: () => Awaitable<T>;
  /** Short factory alias for small in-process runtimes. */
  create?: () => Awaitable<T>;
  maxSlots: number;
  /** Maximum wall-clock lifetime of a slot. Omit to disable. */
  ttlMs?: number;
  /** Maximum idle time of a slot. Omit to disable. */
  idleTtlMs?: number;
  now?: () => number;
};

export type WorkerSlotState = "idle" | "busy" | "poisoned" | "disposed";

export type WorkerSlotSnapshot = {
  id: string;
  namespace: string;
  state: WorkerSlotState;
  createdAt: number;
  lastUsedAt: number;
};

export type WorkerLease<T> = {
  readonly worker: T;
  readonly slotId: string;
  readonly namespace: string;
  readonly decision: WarmWorkerDecision;
  release(options?: WorkerLeaseReleaseOptions): Promise<boolean>;
  poison(cause?: unknown): Promise<boolean>;
};

export type WorkerLeaseReleaseOptions = {
  /** Skip reset and evict the runtime after a task-level failure. */
  poisoned?: boolean;
  cause?: unknown;
};

export type WarmAcquireResult<T> =
  | { kind: "warm"; decision: WarmWorkerDecision; lease: WorkerLease<T> }
  | { kind: "fallback"; decision: ColdFallbackDecision };

export type WorkerPoolSnapshot = {
  slots: number;
  busySlots: number;
  idleSlots: number;
  queuedRequests: number;
  creatingSlots: number;
  disposingSlots: number;
};

export class WorkerPoolAbortedError extends Error {
  constructor() {
    super("Worker pool acquisition aborted");
    this.name = "WorkerPoolAbortedError";
  }
}

export class WorkerPoolClosedError extends Error {
  constructor() {
    super("Worker pool is closed");
    this.name = "WorkerPoolClosedError";
  }
}

export class WorkerPoolIneligibleError extends Error {
  readonly decision: ColdFallbackDecision;

  constructor(decision: ColdFallbackDecision) {
    super(`Warm worker is ineligible: ${decision.reason}`);
    this.name = "WorkerPoolIneligibleError";
    this.decision = decision;
  }
}

export class WorkerPoolSlotError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "WorkerPoolSlotError";
    this.cause = cause;
  }
}
