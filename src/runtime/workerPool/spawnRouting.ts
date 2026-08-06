import { WorkerPool } from "./pool.js";
import type {
  WarmWorkerDecision,
  WorkerLease,
  WorkerPoolDecision,
  WorkerPoolRequest,
  WorkerPoolSnapshot,
} from "./types.js";
import { FIXED_WORKER_MODEL } from "./types.js";

export const MAX_IN_PROCESS_WORKER_POOL_SLOTS = 64;
export const DEFAULT_IN_PROCESS_WORKER_POOL_SLOTS =
  MAX_IN_PROCESS_WORKER_POOL_SLOTS;
export const IN_PROCESS_WORKER_POOL_SLOTS_ENV =
  "MINDCODE_IN_PROCESS_WORKER_POOL_MAX";

/**
 * The persistent teammate runner is not a reusable task runtime: one lease is
 * held for the complete teammate lifecycle. The handle is deliberately
 * metadata-only, so context/tools/policy references cannot survive release.
 */
export type InProcessWorkerHandle = {
  readonly id: number;
  taskId?: string;
  context?: unknown;
  tools?: unknown;
  policy?: unknown;
};

export type InProcessWorkerLease = WorkerLease<InProcessWorkerHandle>;

export type InProcessWorkerSpawnRequest = {
  projectId: string;
  sessionId: string;
  model: string;
  effort: string;
  writeOverlap?: boolean;
  hasWriteOverlap?: boolean;
  overlap?: boolean;
  isolation?: "shared" | "isolated" | "worktree";
};

let nextWorkerId = 0;

function parsePoolSize(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_IN_PROCESS_WORKER_POOL_SLOTS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return DEFAULT_IN_PROCESS_WORKER_POOL_SLOTS;
  }
  return Math.min(parsed, MAX_IN_PROCESS_WORKER_POOL_SLOTS);
}

export function getInProcessWorkerPoolSize(
  env: Record<string, string | undefined> = process.env,
): number {
  return parsePoolSize(env[IN_PROCESS_WORKER_POOL_SLOTS_ENV]);
}

function clearContext(worker: InProcessWorkerHandle): void {
  worker.context = undefined;
}

function clearTools(worker: InProcessWorkerHandle): void {
  worker.tools = undefined;
}

function clearPolicy(worker: InProcessWorkerHandle): void {
  worker.policy = undefined;
}

export const inProcessWorkerPool = new WorkerPool<InProcessWorkerHandle>({
  maxSlots: getInProcessWorkerPoolSize(),
  createWorker: () => ({ id: nextWorkerId++ }),
  reset: (worker) => {
    worker.taskId = undefined;
  },
  resetContext: clearContext,
  resetTools: clearTools,
  resetPolicy: clearPolicy,
});

export function toInProcessWorkerPoolRequest(
  request: InProcessWorkerSpawnRequest,
): WorkerPoolRequest {
  return {
    projectId: request.projectId,
    sessionId: request.sessionId,
    model: request.model || FIXED_WORKER_MODEL,
    effort: request.effort,
    writeOverlap: request.writeOverlap,
    hasWriteOverlap: request.hasWriteOverlap,
    overlap: request.overlap,
    isolation:
      request.isolation === "worktree" ? "isolated" : request.isolation,
  };
}

export function decideInProcessWorkerSpawn(
  request: InProcessWorkerSpawnRequest,
): WorkerPoolDecision {
  return inProcessWorkerPool.decide(toInProcessWorkerPoolRequest(request));
}

/** Best-effort startup warm-up. It never owns scheduler state. */
export async function prewarmInProcessWorker(
  request: InProcessWorkerSpawnRequest,
): Promise<boolean> {
  try {
    return await inProcessWorkerPool.prewarm(
      toInProcessWorkerPoolRequest(request),
    );
  } catch {
    return false;
  }
}

export async function acquireInProcessWorker(
  request: InProcessWorkerSpawnRequest,
): Promise<InProcessWorkerLease> {
  return inProcessWorkerPool.acquire(toInProcessWorkerPoolRequest(request));
}

export function bindInProcessWorker(
  lease: InProcessWorkerLease,
  taskId: string,
  bindings: Pick<InProcessWorkerHandle, "context" | "tools" | "policy"> = {},
): void {
  lease.worker.taskId = taskId;
  lease.worker.context = bindings.context;
  lease.worker.tools = bindings.tools;
  lease.worker.policy = bindings.policy;
}

export function inProcessWorkerPoolSnapshot(): WorkerPoolSnapshot {
  return inProcessWorkerPool.snapshot();
}

export function isWarmInProcessDecision(
  decision: WorkerPoolDecision,
): decision is WarmWorkerDecision {
  return decision.kind === "warm";
}
