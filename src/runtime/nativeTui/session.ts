import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  NativeTuiControlServer,
  type NativeTuiControlServerOptions,
  resolveNativeTuiSocketPath,
} from "./controlServer.js";
import { resolveNativeTuiExecutablePath } from "./path.js";
import {
  type NativeTuiByteInput,
  type NativeTuiByteOutput,
  type NativeTuiPtyExit,
  NativeTuiPtyHost,
  type NativeTuiPtyHostOptions,
} from "./ptyHost.js";

export type NativeTuiFallbackReason =
  | "missing_binary"
  | "unsupported_platform"
  | "control_socket_failure"
  | "pty_failure"
  | "handshake_timeout"
  | "exited_before_ready"
  | "handshake_failure";

export type NativeTuiLaunchResult =
  | {
      source: "native-tui";
      session: NativeTuiSession;
    }
  | {
      source: "fallback";
      reason: NativeTuiFallbackReason;
      error?: unknown;
    };

export class NativeTuiLaunchError extends Error {
  readonly code = "NATIVE_TUI_LAUNCH_ERROR";
  readonly reason: NativeTuiFallbackReason;
  override readonly cause?: unknown;

  constructor(
    reason: NativeTuiFallbackReason,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "NativeTuiLaunchError";
    this.reason = reason;
    this.cause = cause;
  }
}

export type NativeTuiSessionState =
  | "idle"
  | "starting"
  | "ready"
  | "exited"
  | "failed"
  | "closed";

export type NativeTuiConnectionState =
  | "connecting"
  | "reconnecting"
  | "connected"
  | "disconnected"
  | "closed";

export type NativeTuiConnectionStateEvent = {
  state: NativeTuiConnectionState;
  reconnect_attempts: number;
  last_error?: string;
};

export type NativeTuiControlServerLike = Pick<
  NativeTuiControlServer,
  "socketPath" | "start" | "close"
> & {
  readonly connected?: boolean;
};

export type NativeTuiPtyHostLike = Pick<
  NativeTuiPtyHost,
  "start" | "attachInput" | "detachInput" | "resize" | "close"
> & {
  readonly state?: string;
  readonly pid?: number;
};

export type NativeTuiTerminalInput = NativeTuiByteInput;
export type NativeTuiTerminalOutput = NativeTuiByteOutput;

export type NativeTuiSessionOptions = {
  sessionId?: string;
  socketPath?: string;
  runtimeDirectory?: string;
  executablePath?: string;
  executableEnv?: NodeJS.ProcessEnv;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  columns?: number;
  rows?: number;
  handshakeTimeoutMs?: number;
  platform?: NodeJS.Platform;
  runtimePath?: string;
  arch?: string;
  pathExists?: (path: string) => boolean;
  stdin?: NativeTuiTerminalInput;
  stdout?: NativeTuiTerminalOutput;
  createControlServer?: (
    options: NativeTuiControlServerOptions,
  ) => NativeTuiControlServerLike;
  createPtyHost?: (options: NativeTuiPtyHostOptions) => NativeTuiPtyHostLike;
  onInput?: NativeTuiControlServerOptions["onInput"];
  onTerminalSize?: NativeTuiControlServerOptions["onTerminalSize"];
  onCapabilities?: NativeTuiControlServerOptions["onCapabilities"];
  onBeforeConnect?: NativeTuiControlServerOptions["onBeforeConnect"];
  onConnect?: NativeTuiControlServerOptions["onConnect"];
  onDisconnect?: NativeTuiControlServerOptions["onDisconnect"];
  onConnectionStateChange?: (
    event: NativeTuiConnectionStateEvent,
  ) => void | Promise<void>;
  onExit?: (event: NativeTuiPtyExit) => void;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 3_000;
const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;

/**
 * Owns one foreground native TUI process, one PTY, and one control socket.
 * stdin is attached only after the control handshake, which preserves the
 * caller's input stream for the Ink fallback when startup does not complete.
 */
export class NativeTuiSession {
  private readonly options: NativeTuiSessionOptions;
  private readonly sessionIdValue: string;
  private readonly socketPathValue: string;
  private readonly executablePathValue: string;
  private readonly handshakeTimeoutMs: number;
  private readonly stdin?: NativeTuiTerminalInput;
  private readonly stdout?: NativeTuiTerminalOutput;
  private readonly pathExists: (path: string) => boolean;
  private readonly createControlServer: NonNullable<
    NativeTuiSessionOptions["createControlServer"]
  >;
  private readonly createPtyHost: NonNullable<
    NativeTuiSessionOptions["createPtyHost"]
  >;
  private controlServer?: NativeTuiControlServerLike;
  private ptyHost?: NativeTuiPtyHostLike;
  private stateValue: NativeTuiSessionState = "idle";
  private startPromise?: Promise<NativeTuiSession>;
  private closePromise?: Promise<void>;
  private handshakeTimer?: ReturnType<typeof setTimeout>;
  private handshakeResolve?: () => void;
  private handshakeReject?: (error: unknown) => void;
  private handshakeSettled = false;
  private terminalWasRaw = false;
  private terminalRawChanged = false;
  private terminalTakeoverReady = false;
  private closeRequested = false;
  private hasConnected = false;
  private reconnectAttempts = 0;
  private terminalResizeListener?: () => void;

  constructor(options: NativeTuiSessionOptions = {}) {
    this.options = options;
    this.sessionIdValue = options.sessionId ?? randomUUID();
    this.pathExists = options.pathExists ?? existsSync;
    const executableEnv = options.executableEnv ?? options.env ?? process.env;
    this.executablePathValue =
      options.executablePath ??
      resolveNativeTuiExecutablePath(executableEnv, {
        runtimePath: options.runtimePath,
        platform: options.platform,
        arch: options.arch,
        exists: this.pathExists,
      });
    this.handshakeTimeoutMs = positiveInteger(
      options.handshakeTimeoutMs ??
        parsePositiveInteger(
          (options.executableEnv ?? options.env)
            ?.MINDCODE_NATIVE_TUI_HANDSHAKE_TIMEOUT_MS,
        ) ??
        DEFAULT_HANDSHAKE_TIMEOUT_MS,
      DEFAULT_HANDSHAKE_TIMEOUT_MS,
    );
    this.stdin = options.stdin ?? process.stdin;
    this.stdout = options.stdout ?? process.stdout;
    this.createControlServer =
      options.createControlServer ??
      ((serverOptions) => new NativeTuiControlServer(serverOptions));
    this.createPtyHost =
      options.createPtyHost ??
      ((ptyOptions) => new NativeTuiPtyHost(ptyOptions));
    this.socketPathValue =
      options.socketPath ??
      resolveNativeTuiSocketPath(this.sessionIdValue, options.runtimeDirectory);
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get socketPath(): string {
    return this.socketPathValue;
  }

  get executablePath(): string {
    return this.executablePathValue;
  }

  get state(): NativeTuiSessionState {
    return this.stateValue;
  }

  get pid(): number | undefined {
    return this.ptyHost?.pid;
  }

  get ready(): boolean {
    return this.stateValue === "ready";
  }

  get pty(): NativeTuiPtyHostLike | undefined {
    return this.ptyHost;
  }

  get control(): NativeTuiControlServerLike | undefined {
    return this.controlServer;
  }

  async start(): Promise<NativeTuiSession> {
    if (this.stateValue === "ready") return this;
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "idle") {
      throw new NativeTuiLaunchError(
        "handshake_failure",
        `Native TUI session cannot start from state ${this.stateValue}`,
      );
    }
    this.stateValue = "starting";
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      return await promise;
    } catch (error) {
      if (!this.closeRequested) this.stateValue = "failed";
      await this.close().catch(() => undefined);
      throw error;
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined;
    }
  }

  /** Start and convert every pre-ready failure into a typed fallback result. */
  async launch(): Promise<NativeTuiLaunchResult> {
    try {
      await this.start();
      return { source: "native-tui", session: this };
    } catch (error) {
      const launchError = toLaunchError(error);
      return {
        source: "fallback",
        reason: launchError.reason,
        error: launchError.cause ?? launchError,
      };
    }
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  resize(columns: number, rows: number): void {
    this.ptyHost?.resize(columns, rows);
  }

  private currentTerminalSize(): [number, number] {
    return [
      positiveInteger(
        this.options.columns ?? this.stdout?.columns ?? DEFAULT_COLUMNS,
        DEFAULT_COLUMNS,
      ),
      positiveInteger(
        this.options.rows ?? this.stdout?.rows ?? DEFAULT_ROWS,
        DEFAULT_ROWS,
      ),
    ];
  }

  private attachTerminalResize(): void {
    if (this.terminalResizeListener || !this.stdout?.on) return;
    const listener = (): void => {
      const [columns, rows] = this.currentTerminalSize();
      this.resize(columns, rows);
      void this.options.onTerminalSize?.({
        type: "terminal_size",
        version: 1,
        id: "host-resize",
        columns,
        rows,
      });
    };
    this.terminalResizeListener = listener;
    this.stdout.on("resize", listener);
  }

  private detachTerminalResize(): void {
    const listener = this.terminalResizeListener;
    this.terminalResizeListener = undefined;
    if (listener) this.stdout?.removeListener?.("resize", listener);
  }

  private async startInternal(): Promise<NativeTuiSession> {
    this.assertOpen();
    this.notifyConnectionState({
      state: "connecting",
      reconnect_attempts: this.reconnectAttempts,
    });
    if ((this.options.platform ?? process.platform) === "win32") {
      throw new NativeTuiLaunchError(
        "unsupported_platform",
        "Native TUI requires a Unix PTY and Unix control socket",
      );
    }
    if (!this.pathExists(this.executablePathValue)) {
      throw new NativeTuiLaunchError(
        "missing_binary",
        `Native TUI binary does not exist: ${this.executablePathValue}`,
      );
    }

    try {
      this.controlServer = this.createControlServer({
        sessionId: this.sessionIdValue,
        socketPath: this.socketPathValue,
        runtimeDirectory: this.options.runtimeDirectory,
        onBeforeConnect: async () => {
          if (this.hasConnected) {
            this.notifyConnectionState({
              state: "reconnecting",
              reconnect_attempts: this.reconnectAttempts + 1,
            });
          }
          await this.options.onBeforeConnect?.();
          this.assertOpen();
          this.terminalTakeoverReady = true;
        },
        onConnect: async () => {
          if (this.hasConnected) this.reconnectAttempts += 1;
          this.hasConnected = true;
          this.resolveHandshake();
          await this.options.onConnect?.();
          this.notifyConnectionState({
            state: "connected",
            reconnect_attempts: this.reconnectAttempts,
          });
        },
        onDisconnect: async () => {
          await this.options.onDisconnect?.();
          if (!this.closeRequested) {
            this.notifyConnectionState({
              state: "disconnected",
              reconnect_attempts: this.reconnectAttempts,
            });
          }
        },
        onInput: this.options.onInput,
        onTerminalSize: async (event) => {
          this.resize(event.columns, event.rows);
          await this.options.onTerminalSize?.(event);
        },
        onCapabilities: this.options.onCapabilities,
      });
      await this.controlServer.start();
      this.assertOpen();
    } catch (error) {
      if (this.closeRequested) throw error;
      throw new NativeTuiLaunchError(
        "control_socket_failure",
        "Unable to start the native TUI control socket",
        error,
      );
    }

    const handshake = this.waitForHandshake();
    try {
      this.ptyHost = this.createPtyHost({
        executablePath: this.executablePathValue,
        args: [
          ...(this.options.args ?? [
            "--control-socket",
            this.socketPathValue,
            "--session-id",
            this.sessionIdValue,
          ]),
        ],
        cwd: this.options.cwd,
        env: this.options.env,
        cols: this.currentTerminalSize()[0],
        rows: this.currentTerminalSize()[1],
        stdin: this.stdin,
        stdout: undefined,
        onOutput: (chunk) => {
          if (this.terminalTakeoverReady) this.stdout?.write(chunk);
        },
        onExit: (event) => this.handlePtyExit(event),
      });
      await this.ptyHost.start();
      this.assertOpen();
    } catch (error) {
      this.settleHandshake(error);
      await handshake.catch(() => undefined);
      if (this.closeRequested) throw error;
      throw new NativeTuiLaunchError(
        "pty_failure",
        "Unable to start the native TUI PTY",
        error,
      );
    }

    try {
      await handshake;
      this.assertOpen();
      if (this.ptyHost.state === "exited") {
        throw new NativeTuiLaunchError(
          "exited_before_ready",
          "Native TUI exited before the foreground session became ready",
        );
      }
      this.enableTerminalRawMode();
      this.attachTerminalResize();
      this.assertOpen();
      this.ptyHost.attachInput();
      this.stateValue = "ready";
      return this;
    } catch (error) {
      if (error instanceof NativeTuiLaunchError) throw error;
      throw new NativeTuiLaunchError(
        "handshake_failure",
        "Native TUI handshake failed",
        error,
      );
    }
  }

  private waitForHandshake(): Promise<void> {
    if (this.controlServer?.connected) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.handshakeResolve = resolve;
      this.handshakeReject = reject;
      this.handshakeSettled = false;
      this.handshakeTimer = setTimeout(() => {
        this.settleHandshake(
          new NativeTuiLaunchError(
            "handshake_timeout",
            `Native TUI handshake timed out after ${this.handshakeTimeoutMs}ms`,
          ),
        );
      }, this.handshakeTimeoutMs);
    });
  }

  private resolveHandshake(): void {
    if (this.closeRequested) return;
    this.settleHandshake();
  }

  private assertOpen(): void {
    if (!this.closeRequested) return;
    throw new NativeTuiLaunchError(
      "handshake_failure",
      "Native TUI session closed during startup",
    );
  }

  private settleHandshake(error?: unknown): void {
    if (this.handshakeSettled) return;
    this.handshakeSettled = true;
    if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
    this.handshakeTimer = undefined;
    const resolve = this.handshakeResolve;
    const reject = this.handshakeReject;
    this.handshakeResolve = undefined;
    this.handshakeReject = undefined;
    if (error === undefined) resolve?.();
    else reject?.(error);
  }

  private enableTerminalRawMode(): void {
    const stdin = this.stdin;
    if (!stdin?.setRawMode) return;
    this.terminalWasRaw = stdin.isRaw === true;
    stdin.setRawMode(true);
    this.terminalRawChanged = true;
  }

  private handlePtyExit(event: NativeTuiPtyExit): void {
    this.options.onExit?.(event);
    if (this.stateValue === "starting") {
      this.settleHandshake(
        new NativeTuiLaunchError(
          "exited_before_ready",
          `Native TUI exited before handshake (code ${event.exitCode})`,
        ),
      );
      return;
    }
    if (this.stateValue === "ready") {
      this.stateValue = "exited";
      void this.close();
    }
  }

  private async closeInternal(): Promise<void> {
    this.settleHandshake(
      new NativeTuiLaunchError(
        "handshake_failure",
        "Native TUI session closed during startup",
      ),
    );
    this.terminalTakeoverReady = false;
    this.detachTerminalResize();
    this.ptyHost?.detachInput();
    if (this.terminalRawChanged) {
      try {
        this.stdin?.setRawMode?.(this.terminalWasRaw);
      } catch {
        // Terminal teardown must continue even when stdin has already closed.
      }
      this.terminalRawChanged = false;
    }

    const ptyHost = this.ptyHost;
    const controlServer = this.controlServer;
    let firstError: unknown;
    try {
      await ptyHost?.close();
    } catch (error) {
      firstError = error;
    }
    try {
      await controlServer?.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
    this.notifyConnectionState({
      state: "closed",
      reconnect_attempts: this.reconnectAttempts,
    });
    if (this.stateValue !== "exited" && this.stateValue !== "failed") {
      this.stateValue = "closed";
    }
  }

  private notifyConnectionState(event: NativeTuiConnectionStateEvent): void {
    try {
      const result = this.options.onConnectionStateChange?.(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        void (result as Promise<void>).catch(() => undefined);
      }
    } catch {
      // Connection telemetry is observational and must not break session I/O.
    }
  }
}

export async function launchNativeTuiSession(
  options: NativeTuiSessionOptions = {},
): Promise<NativeTuiLaunchResult> {
  return new NativeTuiSession(options).launch();
}

export const openNativeTuiSession = launchNativeTuiSession;
export const launchNativeTuiForeground = launchNativeTuiSession;

function toLaunchError(error: unknown): NativeTuiLaunchError {
  if (error instanceof NativeTuiLaunchError) return error;
  return new NativeTuiLaunchError(
    "handshake_failure",
    "Native TUI launch failed",
    error,
  );
}

function parsePositiveInteger(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
