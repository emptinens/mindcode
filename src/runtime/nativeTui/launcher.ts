import {
  type NativeTuiFeatureGate,
  type NativeTuiFeatureGateOptions,
  resolveNativeTuiFeatureGate,
} from "./featureGate.js";
import {
  NativeTuiLaunchError,
  NativeTuiSession,
  type NativeTuiSessionOptions,
  type NativeTuiFallbackReason as SessionFallbackReason,
} from "./session.js";

export type NativeTuiLaunchCoordinatorState =
  | "idle"
  | "launching"
  | "native"
  | "fallback"
  | "closed";

export type NativeTuiCoordinatorFallbackReason =
  | Exclude<NativeTuiFeatureGate["reason"], "enabled">
  | SessionFallbackReason
  | "launch-timeout"
  | "coordinator-closed";

export type NativeTuiSessionLaunchResult =
  | { source: "native-tui"; session: NativeTuiSessionLike }
  | { source: "fallback"; reason: SessionFallbackReason; error?: unknown };

export type NativeTuiSessionLike = {
  launch(): Promise<NativeTuiSessionLaunchResult>;
  close(): Promise<void>;
};

type NativeTuiSetTimeout = (
  callback: () => void,
  delay: number,
) => ReturnType<typeof globalThis.setTimeout>;
type NativeTuiClearTimeout = (
  timeout: ReturnType<typeof globalThis.setTimeout>,
) => void;

export type NativeTuiLaunchCoordinatorOptions = {
  /** Inputs for the production feature-gate evaluation. */
  gateOptions?: NativeTuiFeatureGateOptions;
  /** A precomputed gate or resolver used by deterministic callers/tests. */
  gate?: NativeTuiFeatureGate | (() => NativeTuiFeatureGate);
  /** Session construction seam; production defaults to NativeTuiSession. */
  createSession?: (options: NativeTuiSessionOptions) => NativeTuiSessionLike;
  sessionOptions?: NativeTuiSessionOptions;
  /** Upper bound for one native launch attempt. */
  launchTimeoutMs?: number;
  /** Timer seams make timeout behavior deterministic without wall-clock sleeps. */
  setTimeout?: NativeTuiSetTimeout;
  clearTimeout?: NativeTuiClearTimeout;
};

export type NativeTuiCoordinatorFallback = {
  source: "fallback";
  kind: "ink-fallback";
  gate: NativeTuiFeatureGate;
  reason: NativeTuiCoordinatorFallbackReason;
  error?: unknown;
  /** Always present so mode=on failures remain a typed fallback result. */
  coordinator: NativeTuiLaunchCoordinator;
};

export type NativeTuiCoordinatorNative = {
  source: "native-tui";
  kind: "native-tui";
  gate: NativeTuiFeatureGate;
  session: NativeTuiSessionLike;
  coordinator: NativeTuiLaunchCoordinator;
};

export type NativeTuiCoordinatorResult =
  | NativeTuiCoordinatorNative
  | NativeTuiCoordinatorFallback;

const DEFAULT_LAUNCH_TIMEOUT_MS = 5_000;

/**
 * Bounded native-TUI selector. It never owns the Ink renderer: every disabled
 * or failed path returns a typed fallback result for the caller to render with
 * Ink instead.
 */
export class NativeTuiLaunchCoordinator {
  private readonly options: NativeTuiLaunchCoordinatorOptions;
  private readonly createSession: NonNullable<
    NativeTuiLaunchCoordinatorOptions["createSession"]
  >;
  private readonly timeoutMs: number;
  private readonly setTimer: NativeTuiSetTimeout;
  private readonly clearTimer: NativeTuiClearTimeout;
  private stateValue: NativeTuiLaunchCoordinatorState = "idle";
  private launchPromise?: Promise<NativeTuiCoordinatorResult>;
  private resultValue?: NativeTuiCoordinatorResult;
  private session?: NativeTuiSessionLike;
  private readonly closedSessions = new WeakSet<NativeTuiSessionLike>();
  private closePromise?: Promise<void>;
  private closeRequested = false;

  constructor(options: NativeTuiLaunchCoordinatorOptions = {}) {
    this.options = options;
    this.createSession =
      options.createSession ??
      ((sessionOptions) => new NativeTuiSession(sessionOptions));
    this.timeoutMs = positiveInteger(
      options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
      DEFAULT_LAUNCH_TIMEOUT_MS,
    );
    this.setTimer = options.setTimeout ?? globalThis.setTimeout;
    this.clearTimer = options.clearTimeout ?? globalThis.clearTimeout;
  }

  get state(): NativeTuiLaunchCoordinatorState {
    return this.stateValue;
  }

  get result(): NativeTuiCoordinatorResult | undefined {
    return this.resultValue;
  }

  async launch(): Promise<NativeTuiCoordinatorResult> {
    if (this.resultValue) return this.resultValue;
    if (this.launchPromise) return this.launchPromise;

    if (this.closeRequested) {
      return this.finishFallback(this.resolveGate(), "coordinator-closed");
    }

    this.stateValue = "launching";
    const promise = this.launchInternal();
    this.launchPromise = promise;
    try {
      return await promise;
    } finally {
      if (this.launchPromise === promise) this.launchPromise = undefined;
    }
  }

  /** Close the native session, if one was constructed, exactly once. */
  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async launchInternal(): Promise<NativeTuiCoordinatorResult> {
    const gate = this.resolveGate();
    if (!gate.enabled) {
      return this.finishFallback(
        gate,
        gate.reason === "enabled" ? "insufficient-capability" : gate.reason,
      );
    }
    if (this.closeRequested) {
      return this.finishFallback(gate, "coordinator-closed");
    }

    let session: NativeTuiSessionLike;
    try {
      session = this.createSession(this.options.sessionOptions ?? {});
      this.session = session;
    } catch (error) {
      return this.finishFallback(gate, errorReason(error), error);
    }

    if (this.closeRequested) {
      await this.closeSession(session);
      return this.finishFallback(gate, "coordinator-closed");
    }

    let launchResult: NativeTuiSessionLaunchResult;
    try {
      launchResult = await this.launchWithTimeout(session);
    } catch (error) {
      await this.closeSession(session);
      return this.finishFallback(gate, errorReason(error), error);
    }

    if (launchResult.source === "fallback") {
      await this.closeSession(session);
      return this.finishFallback(gate, launchResult.reason, launchResult.error);
    }

    if (this.closeRequested) {
      await this.closeSession(session);
      return this.finishFallback(gate, "coordinator-closed");
    }

    this.stateValue = "native";
    const result: NativeTuiCoordinatorNative = {
      source: "native-tui",
      kind: "native-tui",
      gate,
      session: launchResult.session,
      coordinator: this,
    };
    this.resultValue = result;
    return result;
  }

  private resolveGate(): NativeTuiFeatureGate {
    const gate = this.options.gate;
    return typeof gate === "function"
      ? gate()
      : (gate ?? resolveNativeTuiFeatureGate(this.options.gateOptions));
  }

  private async launchWithTimeout(
    session: NativeTuiSessionLike,
  ): Promise<NativeTuiSessionLaunchResult> {
    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const launchPromise = Promise.resolve().then(() => session.launch());
    // The promise may settle after the bounded race; attach a rejection handler
    // before racing so a late PTY/handshake failure cannot become unhandled.
    void launchPromise.catch(() => undefined);
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = this.setTimer(() => {
        reject(
          new NativeTuiLaunchError(
            "handshake_timeout",
            `Native TUI launch timed out after ${this.timeoutMs}ms`,
          ),
        );
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([launchPromise, timeoutPromise]);
    } finally {
      if (timer !== undefined) this.clearTimer(timer);
    }
  }

  private finishFallback(
    gate: NativeTuiFeatureGate,
    reason: NativeTuiCoordinatorFallbackReason,
    error?: unknown,
  ): NativeTuiCoordinatorFallback {
    this.stateValue = "fallback";
    const result: NativeTuiCoordinatorFallback = {
      source: "fallback",
      kind: "ink-fallback",
      gate,
      reason,
      ...(error === undefined ? {} : { error }),
      coordinator: this,
    };
    this.resultValue = result;
    return result;
  }

  private async closeInternal(): Promise<void> {
    const session = this.session;
    if (session) await this.closeSession(session);
    const pendingLaunch = this.launchPromise;
    if (pendingLaunch) await pendingLaunch.catch(() => undefined);
    this.stateValue = "closed";
  }

  private async closeSession(session: NativeTuiSessionLike): Promise<void> {
    if (this.closedSessions.has(session)) return;
    this.closedSessions.add(session);
    try {
      await session.close();
    } catch {
      // A fallback must remain usable even if partial PTY teardown fails.
    }
  }
}

export function createNativeTuiLaunchCoordinator(
  options: NativeTuiLaunchCoordinatorOptions = {},
): NativeTuiLaunchCoordinator {
  return new NativeTuiLaunchCoordinator(options);
}

export async function launchNativeTuiWithFallback(
  options: NativeTuiLaunchCoordinatorOptions = {},
): Promise<NativeTuiCoordinatorResult> {
  return createNativeTuiLaunchCoordinator(options).launch();
}

function errorReason(error: unknown): NativeTuiCoordinatorFallbackReason {
  if (error instanceof NativeTuiLaunchError) return error.reason;
  return "handshake_failure";
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
