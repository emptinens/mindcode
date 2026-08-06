import { type PtyHandle, spawnPty } from "../../utils/pty/ptyBackend.js";

export type NativeTuiPtyExit = {
  exitCode: number;
  signal?: number;
};

export type NativeTuiByteInput = {
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  removeListener?(event: "data", listener: (chunk: unknown) => void): unknown;
  setRawMode?(raw: boolean): unknown;
  readonly isRaw?: boolean;
};

export type NativeTuiByteOutput = {
  write(chunk: Uint8Array): unknown;
};

export type NativeTuiPtySpawn = (
  file: string,
  args: string[],
  options: {
    name?: string;
    cols?: number;
    rows?: number;
    cwd?: string;
    env?: Record<string, string | undefined>;
  },
) => PtyHandle | Promise<PtyHandle>;

export type NativeTuiPtyHostOptions = {
  executablePath: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  cols?: number;
  rows?: number;
  shutdownTimeoutMs?: number;
  stdin?: NativeTuiByteInput;
  stdout?: NativeTuiByteOutput;
  spawn?: NativeTuiPtySpawn;
  onOutput?: (chunk: Uint8Array) => void;
  onExit?: (event: NativeTuiPtyExit) => void;
};

export type NativeTuiPtyHostState =
  | "idle"
  | "starting"
  | "running"
  | "closing"
  | "exited"
  | "closed";

const DEFAULT_COLUMNS = 120;
const DEFAULT_ROWS = 40;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 500;

/**
 * One non-persistent PTY around one foreground native TUI process.
 *
 * This deliberately calls the shared backend selector directly. It does not
 * use the persistent PTY session manager, whose module-level registry would
 * give the foreground launcher the wrong lifecycle and ownership semantics.
 */
export class NativeTuiPtyHost {
  private readonly options: NativeTuiPtyHostOptions;
  private readonly spawnProcess: NativeTuiPtySpawn;
  private readonly stdin?: NativeTuiByteInput;
  private readonly stdout?: NativeTuiByteOutput;
  private readonly onOutput?: NativeTuiPtyHostOptions["onOutput"];
  private readonly onExit?: NativeTuiPtyHostOptions["onExit"];
  private pty?: PtyHandle;
  private dataSubscription?: unknown;
  private exitSubscription?: unknown;
  private inputListener?: (chunk: unknown) => void;
  private stateValue: NativeTuiPtyHostState = "idle";
  private exitValue?: NativeTuiPtyExit;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeRequested = false;
  private exitWaiters = new Set<() => void>();

  constructor(options: NativeTuiPtyHostOptions) {
    this.options = options;
    this.spawnProcess = options.spawn ?? spawnPty;
    this.stdin = options.stdin;
    this.stdout = options.stdout;
    this.onOutput = options.onOutput;
    this.onExit = options.onExit;
  }

  get state(): NativeTuiPtyHostState {
    return this.stateValue;
  }

  get pid(): number | undefined {
    return this.pty?.pid;
  }

  get exit(): NativeTuiPtyExit | undefined {
    return this.exitValue;
  }

  get process(): PtyHandle | undefined {
    return this.pty;
  }

  async start(): Promise<void> {
    if (this.stateValue === "running") return;
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "idle") {
      throw new Error(`PTY host cannot start from state ${this.stateValue}`);
    }

    this.stateValue = "starting";
    const promise = this.startInternal();
    this.startPromise = promise;
    try {
      await promise;
    } finally {
      if (this.startPromise === promise) this.startPromise = undefined;
    }
  }

  private async startInternal(): Promise<void> {
    const pty = await this.spawnProcess(
      this.options.executablePath,
      [...(this.options.args ?? [])],
      {
        name: "xterm-256color",
        cols: this.options.cols ?? DEFAULT_COLUMNS,
        rows: this.options.rows ?? DEFAULT_ROWS,
        cwd: this.options.cwd,
        env: sanitizeNativeTuiEnvironment(process.env, this.options.env),
      },
    );
    this.pty = pty;
    this.dataSubscription = pty.onData((data) => {
      if (this.closeRequested || this.stateValue !== "running") return;
      const chunk = toBytes(data);
      this.stdout?.write(chunk);
      this.onOutput?.(chunk);
    });
    this.exitSubscription = pty.onExit((event) => {
      if (this.stateValue === "closed") return;
      this.exitValue = {
        exitCode: event.exitCode,
        ...(event.signal === undefined ? {} : { signal: event.signal }),
      };
      this.stateValue = this.closeRequested ? "closing" : "exited";
      this.detachInput();
      for (const resolve of this.exitWaiters) resolve();
      this.exitWaiters.clear();
      this.onExit?.(this.exitValue);
    });
    if (this.closeRequested) {
      this.stateValue = "closing";
      await this.terminatePty();
      throw new Error("PTY host closed during startup");
    }
    this.stateValue = "running";
  }

  /** Attach terminal input only after the launch handshake has completed. */
  attachInput(): void {
    if (this.inputListener || !this.stdin || !this.pty) return;
    if (this.stateValue !== "running") {
      throw new Error(`Cannot attach PTY input in state ${this.stateValue}`);
    }
    const listener = (chunk: unknown): void => {
      if (this.stateValue !== "running" || !this.pty) return;
      this.pty.write(toText(chunk));
    };
    this.inputListener = listener;
    this.stdin.on("data", listener);
  }

  detachInput(): void {
    const listener = this.inputListener;
    this.inputListener = undefined;
    if (listener) this.stdin?.removeListener?.("data", listener);
  }

  write(data: Uint8Array | string): void {
    if (this.stateValue !== "running" || !this.pty) {
      throw new Error(`Cannot write to PTY in state ${this.stateValue}`);
    }
    this.pty.write(typeof data === "string" ? data : toText(data));
  }

  resize(columns: number, rows: number): void {
    if (!Number.isInteger(columns) || columns < 1) {
      throw new RangeError("columns must be a positive integer");
    }
    if (!Number.isInteger(rows) || rows < 1) {
      throw new RangeError("rows must be a positive integer");
    }
    if (this.stateValue === "running") this.pty?.resize(columns, rows);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    this.closeRequested = true;
    this.detachInput();
    const startPromise = this.startPromise;
    if (startPromise) await startPromise.catch(() => undefined);
    if (
      this.pty &&
      this.stateValue !== "exited" &&
      this.stateValue !== "closed"
    ) {
      this.stateValue = "closing";
      await this.terminatePty();
    }
    disposeSubscription(this.dataSubscription);
    disposeSubscription(this.exitSubscription);
    this.dataSubscription = undefined;
    this.exitSubscription = undefined;
    this.stateValue = "closed";
  }

  private async terminatePty(): Promise<void> {
    const pty = this.pty;
    if (!pty || this.exitValue) return;
    try {
      pty.kill();
    } catch {
      return;
    }
    const timeoutMs = positiveInteger(
      this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      DEFAULT_SHUTDOWN_TIMEOUT_MS,
    );
    if (await this.waitForExit(timeoutMs)) return;
    try {
      pty.kill("SIGKILL");
    } catch {
      // The PTY may have exited between the timeout and force-kill.
    }
    await this.waitForExit(Math.min(timeoutMs, 100));
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.exitValue) return Promise.resolve(true);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.exitWaiters.delete(onExit);
        resolve(exited);
      };
      const onExit = (): void => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.exitWaiters.add(onExit);
    });
  }
}

export function sanitizeNativeTuiEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const merged = { ...base, ...overrides };
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (
      value !== undefined &&
      isAllowedNativeTuiEnvironmentKey(key) &&
      !isSecretEnvironmentKey(key)
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function isAllowedNativeTuiEnvironmentKey(key: string): boolean {
  return (
    new Set([
      "PATH",
      "HOME",
      "USER",
      "LOGNAME",
      "SHELL",
      "TMPDIR",
      "TMP",
      "TEMP",
      "TEMPDIR",
      "LANG",
      "LANGUAGE",
      "TZ",
      "TERM",
      "TERM_PROGRAM",
      "TERM_PROGRAM_VERSION",
      "COLORTERM",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "BUN_INSTALL",
      "RUST_LOG",
      "RUST_BACKTRACE",
      "NODE_ENV",
      "MINDCODE_NATIVE_TUI",
      "MINDCODE_NATIVE_TUI_PATH",
    ]).has(key) || key.startsWith("LC_")
  );
}

const SECRET_ENVIRONMENT_KEY =
  /(?:^|[_-])(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|AUTH(?:ORIZATION)?)(?:$|[_-])/i;

function isSecretEnvironmentKey(key: string): boolean {
  return SECRET_ENVIRONMENT_KEY.test(key);
}

function toBytes(value: unknown): Uint8Array {
  if (typeof value === "string") return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value));
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString();
  return String(value);
}

function disposeSubscription(subscription: unknown): void {
  if (
    typeof subscription === "object" &&
    subscription !== null &&
    "dispose" in subscription &&
    typeof (subscription as { dispose?: unknown }).dispose === "function"
  ) {
    try {
      (subscription as { dispose: () => void }).dispose();
    } catch {
      // Listener disposal is best effort during one-shot cleanup.
    }
  }
}

function positiveInteger(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
