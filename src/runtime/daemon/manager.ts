import type { ChildProcess } from "node:child_process";
import { DaemonClient } from "./client.js";
import {
  DaemonClientError,
  DaemonDisabledError,
  DaemonDisconnectedError,
  classifyDaemonFallback,
} from "./errors.js";
import { resolveDaemonSocketPath } from "./path.js";
import { spawnMindcodeDaemon } from "./spawn.js";
import type {
  DaemonCallResult,
  DaemonClientOptions,
  DaemonClientState,
  DaemonRequestOptions,
  DaemonSpawnOptions,
  DaemonSpawnResult,
} from "./types.js";

const DEFAULT_READINESS_TIMEOUT_MS = 3_000;
const DEFAULT_INITIAL_BACKOFF_MS = 25;
const DEFAULT_MAX_BACKOFF_MS = 400;
const DEFAULT_MAX_READINESS_ATTEMPTS = 8;

type Timer = ReturnType<typeof setTimeout>;

export type DaemonClientLike = Pick<
  DaemonClient,
  "connect" | "request" | "disconnect" | "close"
> & {
  readonly state: DaemonClientState;
};

export type DaemonManagerClock = {
  now: () => number;
  sleep: (milliseconds: number, ref: boolean) => Promise<void>;
  random: () => number;
};

type StartupMode = "foreground" | "background";

export type DaemonManagerOptions = {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  socketPath?: string;
  clientOptions?: Omit<DaemonClientOptions, "socketPath">;
  createClient?: (options: DaemonClientOptions) => DaemonClientLike;
  spawn?: (options: DaemonSpawnOptions) => DaemonSpawnResult;
  clock?: Partial<DaemonManagerClock>;
  readinessTimeoutMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  maxReadinessAttempts?: number;
};

export type DaemonManagerState =
  | "disabled"
  | "idle"
  | "connecting"
  | "starting"
  | "ready"
  | "unavailable";

export type DaemonManagerStatus = {
  enabled: boolean;
  state: DaemonManagerState;
  socketPath: string;
  spawned: boolean;
  startupInFlight: boolean;
  startupAttempts: number;
  lastError?: string;
};

export function isDaemonEnabled(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform !== "win32" && env.MINDCODE_DAEMON_DISABLED !== "1";
}

export class DaemonManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly platform: NodeJS.Platform;
  private readonly socketPathValue: string;
  private readonly clientOptions: Omit<DaemonClientOptions, "socketPath">;
  private readonly createClient: (
    options: DaemonClientOptions,
  ) => DaemonClientLike;
  private readonly spawnProcess: (
    options: DaemonSpawnOptions,
  ) => DaemonSpawnResult;
  private readonly clock: DaemonManagerClock;
  private readonly readinessTimeoutMs: number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxReadinessAttempts: number;

  private client?: DaemonClientLike;
  private child?: ChildProcess;
  private readyPromise?: Promise<void>;
  private readyMode?: StartupMode;
  private startupTimer?: Timer;
  private foregroundHoldTimer?: Timer;
  private startupAttempts = 0;
  private lastError?: unknown;
  private lifecycleGeneration = 0;

  constructor(options: DaemonManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
    this.socketPathValue =
      options.socketPath ?? resolveDaemonSocketPath(this.env);
    this.clientOptions = options.clientOptions ?? {};
    this.createClient =
      options.createClient ??
      ((clientOptions) => new DaemonClient(clientOptions));
    this.spawnProcess =
      options.spawn ?? ((spawnOptions) => spawnMindcodeDaemon(spawnOptions));
    this.clock = {
      now: options.clock?.now ?? Date.now,
      sleep: options.clock?.sleep ?? sleepWithRef,
      random: options.clock?.random ?? Math.random,
    };
    this.readinessTimeoutMs = boundedPositive(
      options.readinessTimeoutMs ??
        parsePositiveInteger(this.env.MINDCODE_DAEMON_READINESS_TIMEOUT_MS) ??
        DEFAULT_READINESS_TIMEOUT_MS,
    );
    this.initialBackoffMs = boundedPositive(
      options.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    );
    this.maxBackoffMs = Math.max(
      this.initialBackoffMs,
      boundedPositive(options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
    );
    this.maxReadinessAttempts = Math.max(
      1,
      Math.floor(
        options.maxReadinessAttempts ?? DEFAULT_MAX_READINESS_ATTEMPTS,
      ),
    );
  }

  get enabled(): boolean {
    return isDaemonEnabled(this.env, this.platform);
  }

  get socketPath(): string {
    return this.socketPathValue;
  }

  /**
   * Schedule a best-effort warm-up after the full CLI path has started. It is
   * deliberately not awaited and its timer cannot keep a short-lived command
   * alive. Actual daemon-backed calls still use ensureReady directly.
   */
  kickStartup(): void {
    if (!this.enabled || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = undefined;
      void this.ensureReady("background").catch((error: unknown) => {
        this.lastError = error;
      });
    }, 0);
    unrefTimer(this.startupTimer);
  }

  async ensureReady(mode: StartupMode = "foreground"): Promise<void> {
    if (!this.enabled) throw new DaemonDisabledError();
    if (this.client?.state === "ready") return;
    if (this.readyPromise) {
      if (mode === "foreground" && this.readyMode === "background") {
        this.promoteBackgroundStartup();
      }
      return this.readyPromise;
    }

    const generation = this.lifecycleGeneration;
    this.readyMode = mode;
    if (mode === "foreground") this.promoteBackgroundStartup();
    const promise = this.establishReady(generation, mode);
    this.readyPromise = promise;
    try {
      await promise;
    } finally {
      if (this.readyPromise === promise) {
        this.readyPromise = undefined;
        this.readyMode = undefined;
        this.clearForegroundHold();
      }
    }
  }

  async requestWithFallback<T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options: DaemonRequestOptions = {},
  ): Promise<DaemonCallResult<T>> {
    try {
      await this.ensureReady();
      const client = this.client;
      if (!client || client.state !== "ready") {
        throw new DaemonDisconnectedError();
      }
      return {
        source: "daemon",
        value: await client.request<T>(method, params, options),
      };
    } catch (error) {
      this.lastError = error;
      if (
        this.client?.state !== "ready" ||
        error instanceof DaemonDisconnectedError
      ) {
        this.client?.disconnect();
      }
      const value =
        typeof fallback === "function"
          ? await (fallback as () => T | Promise<T>)()
          : fallback;
      return {
        source: "fallback",
        value,
        reason: classifyDaemonFallback(error),
        error,
      };
    }
  }

  status(): DaemonManagerStatus {
    const enabled = this.enabled;
    let state: DaemonManagerState = enabled ? "idle" : "disabled";
    if (enabled) {
      if (this.client?.state === "ready") state = "ready";
      else if (this.readyPromise)
        state = this.child ? "connecting" : "starting";
      else if (this.lastError) state = "unavailable";
    }
    return {
      enabled,
      state,
      socketPath: this.socketPathValue,
      spawned: this.child !== undefined,
      startupInFlight: this.readyPromise !== undefined,
      startupAttempts: this.startupAttempts,
      ...(this.lastError ? { lastError: errorText(this.lastError) } : {}),
    };
  }

  getStatus(): DaemonManagerStatus {
    return this.status();
  }

  /**
   * Release this process's client and pending startup work. The detached
   * sidecar is intentionally left alive; it owns its own idle shutdown.
   */
  async cleanup(): Promise<void> {
    this.lifecycleGeneration += 1;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.clearForegroundHold();
    const pendingStartup = this.readyPromise;
    this.readyPromise = undefined;
    this.readyMode = undefined;
    this.client?.close();
    this.client = undefined;
    // Do not kill the detached daemon. Its idle timeout is the owner of its
    // lifecycle, and another MindCode process may be using it.
    this.child = undefined;
    void pendingStartup?.catch(() => undefined);
  }

  /** Test-only lifecycle reset. It never sends a shutdown request to a shared daemon. */
  async shutdownForTests(): Promise<void> {
    this.lifecycleGeneration += 1;
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = undefined;
    }
    this.clearForegroundHold();
    const pendingStartup = this.readyPromise;
    this.readyPromise = undefined;
    this.readyMode = undefined;
    if (pendingStartup) await pendingStartup.catch(() => undefined);

    this.client?.close();
    this.client = undefined;
    const child = this.child;
    this.child = undefined;
    if (child) {
      try {
        child.kill();
      } catch {
        // The process may have exited between the state check and kill().
      }
    }
    this.lastError = undefined;
    this.startupAttempts = 0;
  }

  private async establishReady(
    generation: number,
    mode: StartupMode,
  ): Promise<void> {
    const startedAt = this.clock.now();
    let lastError: unknown;
    this.client ??= this.createClient({
      ...this.clientOptions,
      socketPath: this.socketPathValue,
    });

    try {
      await this.client.connect();
      this.lastError = undefined;
      return;
    } catch (error) {
      lastError = error;
      this.lastError = error;
    }

    if (generation !== this.lifecycleGeneration) return;
    this.startupAttempts += 1;
    this.startSidecar();

    for (let attempt = 0; attempt < this.maxReadinessAttempts; attempt += 1) {
      if (generation !== this.lifecycleGeneration) return;
      const elapsed = this.clock.now() - startedAt;
      const remaining = this.readinessTimeoutMs - elapsed;
      if (remaining <= 0) break;
      const exponential = Math.min(
        this.maxBackoffMs,
        this.initialBackoffMs * 2 ** attempt,
      );
      const jitter = 0.75 + clampUnit(this.clock.random()) * 0.5;
      await this.clock.sleep(
        Math.min(remaining, Math.max(1, Math.floor(exponential * jitter))),
        mode === "foreground",
      );
      if (this.clock.now() - startedAt >= this.readinessTimeoutMs) break;
      try {
        await this.client.connect();
        this.lastError = undefined;
        return;
      } catch (error) {
        lastError = error;
        this.lastError = error;
      }
    }

    throw new DaemonClientError(
      "DAEMON_UNAVAILABLE",
      `MindCode daemon was not ready within ${this.readinessTimeoutMs}ms`,
      lastError,
    );
  }

  private startSidecar(): void {
    if (this.child) return;
    let spawned: DaemonSpawnResult;
    try {
      spawned = this.spawnProcess({ socketPath: this.socketPathValue });
    } catch (error) {
      this.lastError = error;
      return;
    }

    const child = spawned.process;
    this.child = child;
    const onExit = (): void => {
      if (this.child !== child) return;
      this.child = undefined;
      this.client?.disconnect();
    };
    // ChildProcess error events must always have a listener. The listener is
    // also the only source of lifecycle state for failed detached launches.
    child.once("error", (error) => {
      this.lastError = error;
      onExit();
    });
    child.once("exit", onExit);
    child.once("close", onExit);
  }

  private promoteBackgroundStartup(): void {
    if (this.foregroundHoldTimer) return;
    // The default daemon/client timers are unref'ed for background startup.
    // A foreground caller joining that single-flight needs one ref'ed handle
    // until the bounded readiness operation settles, otherwise a short-lived
    // `-p` process can disappear before its fallback executes.
    const holdMs =
      this.readinessTimeoutMs + Math.max(this.maxBackoffMs, 1_500) + 1_000;
    this.foregroundHoldTimer = setTimeout(() => {
      this.foregroundHoldTimer = undefined;
    }, holdMs);
    const candidate = this.foregroundHoldTimer as Timer & {
      ref?: () => void;
    };
    candidate.ref?.();
  }

  private clearForegroundHold(): void {
    if (!this.foregroundHoldTimer) return;
    clearTimeout(this.foregroundHoldTimer);
    this.foregroundHoldTimer = undefined;
  }
}

let singleton: DaemonManager | undefined;

export function getDaemonManager(
  options?: DaemonManagerOptions,
): DaemonManager {
  singleton ??= new DaemonManager(options);
  return singleton;
}

export async function shutdownDaemonManagerForTests(): Promise<void> {
  if (!singleton) return;
  const manager = singleton;
  singleton = undefined;
  await manager.shutdownForTests();
}

export async function cleanupDaemonManager(): Promise<void> {
  await singleton?.cleanup();
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function boundedPositive(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  return Math.min(Math.floor(value), 2 ** 31 - 1);
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unrefTimer(timer: Timer): void {
  const candidate = timer as Timer & { unref?: () => void };
  candidate.unref?.();
}

function sleepWithRef(milliseconds: number, ref: boolean): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    if (!ref) unrefTimer(timer);
  });
}
