import type { TaskRecord } from "../../tasks/graph/types.js";
import {
  DaemonCancelledError,
  DaemonDisconnectedError,
} from "../daemon/errors.js";
import type { TaskGraphDaemonClient } from "../taskGraph/client.js";
import type { TaskGraphWatchParams } from "../taskGraph/protocol.js";
import { streamTaskGraph } from "../taskGraph/stream.js";
import type { StreamingDagCoordinator } from "./coordinator.js";
import {
  type DaemonSnapshotAdapterOptions,
  normalizeDaemonWatchChunk,
} from "./daemonAdapter.js";
import type {
  StreamingDagApplyResult,
  StreamingDagLimits,
  StreamingDagSnapshot,
} from "./types.js";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_RETRY_BASE_MS = 50;
const DEFAULT_RETRY_MAX_MS = 1_000;
const DEFAULT_IDLE_RESTART_DELAY_MS = 10;
const MAX_RETRIES = 32;
const MAX_RETRY_DELAY_MS = 120_000;

export type StreamingDagWatchBridgeOptions<
  TTask = unknown,
  TResult = unknown,
> = {
  client: TaskGraphDaemonClient;
  coordinator: StreamingDagCoordinator<TTask, TResult>;
  signal?: AbortSignal;
  afterVersion?: number;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
  idleRestartDelayMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  maxBufferedEvents?: number;
  limits?: Partial<StreamingDagLimits>;
  payload?: (task: TaskRecord) => TTask;
  onRetry?: (attempt: number, delayMs: number) => void;
};

export type StreamingDagWatchBridgeState = {
  running: boolean;
  stopped: boolean;
  lastVersion: number | null;
  lastSequence: number | null;
  retries: number;
};

/**
 * Connects the daemon's authoritative task-graph watch to one coordinator.
 *
 * The daemon stream is deliberately treated as a snapshot stream. The daemon
 * does not expose task events that can be safely replayed into the coordinator;
 * every changed/resync chunk therefore replaces the authoritative DAG.
 */
export class StreamingDagWatchBridge<TTask = unknown, TResult = unknown> {
  private readonly options: StreamingDagWatchBridgeOptions<TTask, TResult>;
  private readonly controller = new AbortController();
  private externalSignal?: AbortSignal;
  private externalAbortListener?: () => void;
  private completion?: Promise<void>;
  private stopped = false;
  private finished = false;
  private lastVersionValue: number | null = null;
  private lastSequenceValue: number | null = null;
  private retryCount = 0;

  constructor(options: StreamingDagWatchBridgeOptions<TTask, TResult>) {
    validateOptions(options);
    this.options = options;
    if (options.signal) {
      this.externalSignal = options.signal;
      this.externalAbortListener = () => {
        this.controller.abort(options.signal?.reason);
      };
      options.signal.addEventListener("abort", this.externalAbortListener, {
        once: true,
      });
      if (options.signal.aborted) this.externalAbortListener();
    }
  }

  get state(): StreamingDagWatchBridgeState {
    return {
      running: this.completion !== undefined && !this.stopped && !this.finished,
      stopped: this.stopped || this.finished || this.controller.signal.aborted,
      lastVersion: this.lastVersionValue,
      lastSequence: this.lastSequenceValue,
      retries: this.retryCount,
    };
  }

  get lastVersion(): number | null {
    return this.lastVersionValue;
  }

  /** Starts the bridge once. Repeated calls share the same completion promise. */
  start(): Promise<void> {
    if (this.completion) return this.completion;
    if (this.stopped || this.controller.signal.aborted) {
      this.completion = Promise.resolve();
      this.cleanup();
      return this.completion;
    }
    this.completion = this.runInternal();
    void this.completion.finally(() => this.cleanup()).catch(() => undefined);
    return this.completion;
  }

  run(): Promise<void> {
    return this.start();
  }

  stop(reason: unknown = new DaemonCancelledError()): void {
    if (this.stopped) return;
    this.stopped = true;
    this.controller.abort(reason);
  }

  dispose(reason?: unknown): void {
    this.stop(reason);
  }

  private async runLoop(): Promise<void> {
    let afterVersion = this.options.afterVersion;
    let initialSnapshot = this.lastSequenceValue === null;

    while (!this.controller.signal.aborted) {
      const params = watchParams(this.options, afterVersion);
      const stream = streamTaskGraph(this.options.client, params, {
        signal: this.controller.signal,
        maxBufferedEvents: this.options.maxBufferedEvents,
      });

      try {
        for await (const event of stream) {
          if (this.controller.signal.aborted) return;

          const normalized = normalizeDaemonWatchChunk<
            unknown,
            TTask,
            TaskRecord
          >(event, adapterOptions(this.options));
          const snapshot = normalized.snapshot as StreamingDagSnapshot<
            TTask,
            TResult
          >;
          if (
            isDuplicate(snapshot, this.lastSequenceValue, this.lastVersionValue)
          ) {
            continue;
          }

          const result =
            initialSnapshot && normalized.kind === "snapshot"
              ? this.options.coordinator.applySnapshot(snapshot)
              : this.options.coordinator.reconnect(snapshot);
          assertApplied(result);
          this.lastSequenceValue = snapshot.sequence;
          this.lastVersionValue = snapshot.graphVersion;
          afterVersion = maxVersion(afterVersion, snapshot.graphVersion);
          initialSnapshot = false;
          this.retryCount = 0;
        }

        const result = await stream.completion;
        if (result.reason !== "idle_timeout") return;
        afterVersion = maxVersion(afterVersion, result.last_version);
        await abortableDelay(
          this.options.idleRestartDelayMs ??
            this.options.pollIntervalMs ??
            DEFAULT_IDLE_RESTART_DELAY_MS,
          this.controller.signal,
        );
      } catch (error) {
        if (this.controller.signal.aborted || isCancellation(error)) return;
        if (!isTransportDisconnect(error)) throw error;

        this.options.coordinator.disconnectLeader();
        if (
          this.retryCount >= (this.options.maxRetries ?? DEFAULT_MAX_RETRIES)
        ) {
          throw error;
        }
        this.retryCount += 1;
        const delayMs = retryDelay(this.retryCount, this.options);
        this.options.onRetry?.(this.retryCount, delayMs);
        await abortableDelay(delayMs, this.controller.signal);
      }
    }
  }

  private async runInternal(): Promise<void> {
    try {
      await this.runLoop();
    } finally {
      this.finished = true;
      this.cleanup();
    }
  }

  private cleanup(): void {
    if (this.externalSignal && this.externalAbortListener) {
      this.externalSignal.removeEventListener(
        "abort",
        this.externalAbortListener,
      );
    }
    this.externalSignal = undefined;
    this.externalAbortListener = undefined;
  }
}

export function createStreamingDagWatchBridge<
  TTask = unknown,
  TResult = unknown,
>(
  options: StreamingDagWatchBridgeOptions<TTask, TResult>,
): StreamingDagWatchBridge<TTask, TResult> {
  return new StreamingDagWatchBridge(options);
}

export const connectStreamingDagWatch = createStreamingDagWatchBridge;

function watchParams<TTask, TResult>(
  options: StreamingDagWatchBridgeOptions<TTask, TResult>,
  afterVersion: number | undefined,
): TaskGraphWatchParams {
  return {
    ...(afterVersion === undefined ? {} : { after_version: afterVersion }),
    ...(options.pollIntervalMs === undefined
      ? {}
      : { poll_interval_ms: options.pollIntervalMs }),
    ...(options.idleTimeoutMs === undefined
      ? {}
      : { idle_timeout_ms: options.idleTimeoutMs }),
  };
}

function adapterOptions<TTask, TResult>(
  options: StreamingDagWatchBridgeOptions<TTask, TResult>,
): DaemonSnapshotAdapterOptions<unknown, TTask, TaskRecord> {
  return {
    limits: options.limits,
    payload: options.payload,
  };
}

function isDuplicate<TResult>(
  snapshot: StreamingDagSnapshot<unknown, TResult>,
  lastSequence: number | null,
  lastVersion: number | null,
): boolean {
  if (lastSequence === null || lastVersion === null) return false;
  return (
    snapshot.sequence < lastSequence ||
    snapshot.graphVersion < lastVersion ||
    (snapshot.sequence === lastSequence &&
      snapshot.graphVersion === lastVersion)
  );
}

function assertApplied(result: StreamingDagApplyResult): void {
  if (result.kind === "resync_required") {
    throw new Error(
      `Coordinator rejected authoritative snapshot: ${result.reason}`,
    );
  }
  if (result.kind === "rejected") {
    throw new Error(
      `Coordinator rejected authoritative snapshot: ${result.reason}`,
    );
  }
}

function isTransportDisconnect(error: unknown): boolean {
  if (error instanceof DaemonDisconnectedError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "DAEMON_DISCONNECTED"
  );
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof DaemonCancelledError ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function maxVersion(current: number | undefined, candidate: number): number {
  return current === undefined ? candidate : Math.max(current, candidate);
}

function retryDelay<TTask, TResult>(
  attempt: number,
  options: StreamingDagWatchBridgeOptions<TTask, TResult>,
): number {
  const base = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const maximum = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  return Math.min(maximum, base * 2 ** Math.max(0, attempt - 1));
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timerRef: { value?: ReturnType<typeof setTimeout> } = {};
    const onAbort = () => {
      if (timerRef.value !== undefined) clearTimeout(timerRef.value);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    timerRef.value = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validateOptions<TTask, TResult>(
  options: StreamingDagWatchBridgeOptions<TTask, TResult>,
): void {
  if (!options.client || !options.coordinator) {
    throw new TypeError("client and coordinator are required");
  }
  safeRange(options.afterVersion, 0, Number.MAX_SAFE_INTEGER, "afterVersion");
  safeRange(options.pollIntervalMs, 10, 1_000, "pollIntervalMs");
  safeRange(options.idleTimeoutMs, 100, 120_000, "idleTimeoutMs");
  safeRange(options.idleRestartDelayMs, 1, 120_000, "idleRestartDelayMs");
  safeRange(options.maxRetries, 0, MAX_RETRIES, "maxRetries");
  safeRange(options.retryBaseMs, 1, MAX_RETRY_DELAY_MS, "retryBaseMs");
  safeRange(options.retryMaxMs, 1, MAX_RETRY_DELAY_MS, "retryMaxMs");
}

function safeRange(
  value: number | undefined,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < minimum || value > maximum)
  ) {
    throw new TypeError(
      `${name} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
}
