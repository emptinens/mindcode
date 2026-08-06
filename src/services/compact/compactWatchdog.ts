import { createChildAbortController } from "../../utils/abortController.js";
import type { FileStateCache } from "../../utils/fileStateCache.js";

export const DEFAULT_COMPACT_TIMEOUT_MS = 120_000;
export const COMPACT_TIMEOUT_ENV = "MINDCODE_COMPACT_TIMEOUT_MS";

export class CompactTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Compaction timed out after ${timeoutMs}ms.`);
    this.name = "CompactTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export function resolveCompactTimeoutMs(
  value: string | undefined = process.env[COMPACT_TIMEOUT_ENV],
): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_COMPACT_TIMEOUT_MS;
}

export type CompactWatchdog = {
  controller: AbortController;
  timeoutMs: number;
  guard<T>(promise: PromiseLike<T>): Promise<T>;
  dispose(): void;
};

function abortReasonToError(reason: unknown): unknown {
  return reason instanceof Error
    ? reason
    : new Error(String(reason ?? "Compaction canceled."));
}

/**
 * Creates a child cancellation scope for one compaction transaction.
 * Parent cancellation propagates to the child; the timeout only aborts the
 * child and never cancels the parent session.
 */
export function createCompactWatchdog(
  parent: AbortController,
  timeoutMs = resolveCompactTimeoutMs(),
): CompactWatchdog {
  const controller = createChildAbortController(parent);
  const timeoutError = new CompactTimeoutError(timeoutMs);
  const timeout = setTimeout(() => controller.abort(timeoutError), timeoutMs);

  return {
    controller,
    timeoutMs,
    guard<T>(promise: PromiseLike<T>): Promise<T> {
      if (controller.signal.aborted) {
        return Promise.reject(abortReasonToError(controller.signal.reason));
      }

      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          cleanup();
          reject(abortReasonToError(controller.signal.reason));
        };
        const cleanup = () =>
          controller.signal.removeEventListener("abort", onAbort);

        controller.signal.addEventListener("abort", onAbort, { once: true });
        Promise.resolve(promise).then(
          (value) => {
            cleanup();
            resolve(value);
          },
          (error) => {
            cleanup();
            reject(error);
          },
        );
      });
    },
    dispose(): void {
      clearTimeout(timeout);
      if (!controller.signal.aborted) {
        controller.abort();
      }
    },
  };
}

export type CompactStateSnapshot = {
  readFileState: ReturnType<FileStateCache["dump"]>;
  loadedNestedMemoryPaths?: Set<string>;
};

type CompactStateTransactionStatus = "active" | "committed" | "rolled_back";

export function snapshotCompactState(
  readFileState: FileStateCache,
  loadedNestedMemoryPaths?: Set<string>,
): CompactStateSnapshot {
  return {
    readFileState: readFileState.dump(),
    loadedNestedMemoryPaths: loadedNestedMemoryPaths
      ? new Set(loadedNestedMemoryPaths)
      : undefined,
  };
}

/** Owns mutable compact state across optimization and fallback attempts. */
export class CompactStateTransaction {
  readonly snapshot: CompactStateSnapshot;
  private status: CompactStateTransactionStatus = "active";

  constructor(
    private readonly readFileState: FileStateCache,
    private readonly loadedNestedMemoryPaths?: Set<string>,
  ) {
    this.snapshot = snapshotCompactState(
      readFileState,
      loadedNestedMemoryPaths,
    );
  }

  get isActive(): boolean {
    return this.status === "active";
  }

  get isCommitted(): boolean {
    return this.status === "committed";
  }

  get isRolledBack(): boolean {
    return this.status === "rolled_back";
  }

  /** Restore the initial snapshot while leaving fallback eligible. */
  restoreForFallback(): void {
    if (this.status !== "active") return;
    restoreCompactState(
      this.readFileState,
      this.loadedNestedMemoryPaths,
      this.snapshot,
    );
  }

  /** Clear compact state once, after the final result and hooks succeed. */
  commit(): void {
    if (this.status !== "active") return;
    commitCompactState(this.readFileState, this.loadedNestedMemoryPaths);
    this.status = "committed";
  }

  /** Restore compact state once after a terminal failure or cancellation. */
  rollback(): void {
    if (this.status !== "active") return;
    this.restoreForFallback();
    this.status = "rolled_back";
  }
}

export function createCompactStateTransaction(
  readFileState: FileStateCache,
  loadedNestedMemoryPaths?: Set<string>,
): CompactStateTransaction {
  return new CompactStateTransaction(readFileState, loadedNestedMemoryPaths);
}

/** Commit is deliberately the final state mutation after all compact hooks. */
export function commitCompactState(
  readFileState: FileStateCache,
  loadedNestedMemoryPaths?: Set<string>,
): void {
  readFileState.clear();
  loadedNestedMemoryPaths?.clear();
}

/** Restore all state touched by a failed compact transaction. */
export function restoreCompactState(
  readFileState: FileStateCache,
  loadedNestedMemoryPaths: Set<string> | undefined,
  snapshot: CompactStateSnapshot,
): void {
  readFileState.clear();
  readFileState.load(snapshot.readFileState);
  if (loadedNestedMemoryPaths) {
    loadedNestedMemoryPaths.clear();
    for (const path of snapshot.loadedNestedMemoryPaths ?? []) {
      loadedNestedMemoryPaths.add(path);
    }
  }
}
