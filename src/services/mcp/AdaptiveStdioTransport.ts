import { PassThrough, type Stream } from "node:stream";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import { getDaemonManager } from "../../runtime/daemon/manager.js";
import type { McpStdioServerParameters } from "../../runtime/mcpStdio/types.js";
import { RustStdioTransport } from "./RustStdioTransport.js";

type ManagedStdioTransport = Transport & {
  readonly stderr?: Stream | null;
  readonly pid?: number | null;
  readonly ownsProcess?: boolean;
  readonly openDispatched?: boolean;
};

export type AdaptiveStdioAuthority = "none" | "rust" | "sdk";

export type AdaptiveStdioTransportOptions = {
  rustFactory?: (server: McpStdioServerParameters) => ManagedStdioTransport;
  sdkFactory?: (server: McpStdioServerParameters) => ManagedStdioTransport;
  daemonReady?: () => void | Promise<void>;
  sdkEnv?: Readonly<Record<string, string>>;
};

/**
 * Uses the native daemon for stdio MCP servers and falls back to the SDK only
 * when daemon readiness fails before the native open request is dispatched.
 * Once either implementation starts successfully, its authority is pinned for
 * the lifetime of this transport.
 */
export class AdaptiveStdioTransport implements ManagedStdioTransport {
  private readonly server: McpStdioServerParameters;
  private readonly rustFactory: (
    server: McpStdioServerParameters,
  ) => ManagedStdioTransport;
  private readonly sdkFactory: (
    server: McpStdioServerParameters,
  ) => ManagedStdioTransport;
  private readonly daemonReady: () => void | Promise<void>;
  private readonly sdkEnv?: Readonly<Record<string, string>>;
  private readonly stderrProxy = new PassThrough();
  private stderrSource?: Stream;
  private stderrForwarder?: (chunk: unknown) => void;
  private activeTransport?: ManagedStdioTransport;
  private authorityValue: AdaptiveStdioAuthority = "none";
  private stateValue:
    | "new"
    | "starting"
    | "running"
    | "closing"
    | "closed"
    | "failed" = "new";
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closeRequested = false;
  private closeNotified = false;
  private deferredRustStartError?: Error;

  private oncloseValue?: () => void;
  private onerrorValue?: (error: Error) => void;
  private onmessageValue?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(
    server: McpStdioServerParameters,
    options: AdaptiveStdioTransportOptions = {},
  ) {
    this.server = {
      command: server.command,
      ...(server.args === undefined ? {} : { args: [...server.args] }),
      ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
      ...(server.env === undefined ? {} : { env: { ...server.env } }),
    };
    this.daemonReady =
      options.daemonReady ?? (() => getDaemonManager().ensureReady());
    this.sdkEnv = options.sdkEnv;
    this.rustFactory =
      options.rustFactory ??
      ((parameters) =>
        new RustStdioTransport(parameters, {
          beforeOpen: this.daemonReady,
        }));
    this.sdkFactory =
      options.sdkFactory ??
      ((parameters) =>
        new StdioClientTransport({
          command: parameters.command,
          args:
            parameters.args === undefined ? undefined : [...parameters.args],
          cwd: parameters.cwd,
          env: (this.sdkEnv ?? parameters.env) as
            | Record<string, string>
            | undefined,
          stderr: "pipe",
        }) as ManagedStdioTransport);
  }

  get authority(): AdaptiveStdioAuthority {
    return this.authorityValue;
  }

  get pid(): number | null {
    return this.activeTransport?.pid ?? null;
  }

  get stderr(): Stream | null {
    return this.stderrProxy;
  }

  /** SDK owns its child process; the Rust daemon owns the native child. */
  get ownsProcess(): boolean {
    return this.activeTransport?.ownsProcess ?? this.authorityValue === "sdk";
  }

  get openDispatched(): boolean {
    return this.activeTransport?.openDispatched ?? false;
  }

  set onclose(handler: (() => void) | undefined) {
    this.oncloseValue = handler;
  }

  get onclose(): (() => void) | undefined {
    return this.oncloseValue;
  }

  set onerror(handler: ((error: Error) => void) | undefined) {
    this.onerrorValue = handler;
  }

  get onerror(): ((error: Error) => void) | undefined {
    return this.onerrorValue;
  }

  set onmessage(handler:
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined) {
    this.onmessageValue = handler;
  }

  get onmessage():
    | (<T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void)
    | undefined {
    return this.onmessageValue;
  }

  async start(): Promise<void> {
    if (this.stateValue === "running") {
      throw new Error("AdaptiveStdioTransport already started");
    }
    if (this.startPromise) return this.startPromise;
    if (this.closeRequested || this.stateValue !== "new") {
      throw new Error("AdaptiveStdioTransport cannot be restarted");
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

  async send(
    message: JSONRPCMessage,
    options?: TransportSendOptions,
  ): Promise<void> {
    if (this.stateValue !== "running" || !this.activeTransport) {
      throw new Error("AdaptiveStdioTransport is not running");
    }
    await this.activeTransport.send(message, options);
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closeRequested = true;
    const promise = this.closeInternal();
    this.closePromise = promise;
    return promise;
  }

  private async startInternal(): Promise<void> {
    const rust = this.rustFactory(this.server);
    this.activeTransport = rust;
    this.attach(rust, true);

    try {
      await rust.start();
      if (this.closeRequested) {
        throw new Error("AdaptiveStdioTransport closed during start");
      }
      this.authorityValue = "rust";
      this.stateValue = "running";
      this.deferredRustStartError = undefined;
      return;
    } catch (rustError) {
      this.detach(rust);
      this.activeTransport = undefined;

      if (this.closeRequested || !shouldFallbackToSdk(rustError, rust)) {
        await rust.close().catch(() => undefined);
        this.stateValue = this.closeRequested ? "closing" : "failed";
        this.emitError(this.deferredRustStartError ?? toError(rustError));
        this.deferredRustStartError = undefined;
        throw rustError;
      }

      this.deferredRustStartError = undefined;
      await rust.close().catch(() => undefined);
      if (this.closeRequested) {
        this.stateValue = "closing";
        throw rustError;
      }

      const sdk = this.sdkFactory(this.server);
      this.activeTransport = sdk;
      this.attach(sdk);
      try {
        await sdk.start();
        if (this.closeRequested) {
          throw new Error("AdaptiveStdioTransport closed during SDK start");
        }
        this.authorityValue = "sdk";
        this.stateValue = "running";
      } catch (sdkError) {
        this.detach(sdk);
        this.activeTransport = undefined;
        this.stateValue = this.closeRequested ? "closing" : "failed";
        await sdk.close().catch(() => undefined);
        throw sdkError;
      }
    }
  }

  private async closeInternal(): Promise<void> {
    this.stateValue = "closing";
    await this.startPromise?.catch(() => undefined);

    const active = this.activeTransport;
    this.activeTransport = undefined;
    let closeError: unknown;
    if (active) {
      this.detach(active);
      try {
        await active.close();
      } catch (error) {
        closeError = error;
      }
    }

    this.stateValue = "closed";
    this.stderrProxy.end();
    this.notifyClose();
    if (closeError !== undefined) throw toError(closeError);
  }

  private attach(
    transport: ManagedStdioTransport,
    deferStartErrors = false,
  ): void {
    const stderr = transport.stderr;
    if (stderr) {
      const forward = (chunk: unknown) => {
        if (!this.stderrProxy.destroyed) this.stderrProxy.write(chunk);
      };
      stderr.on("data", forward);
      this.stderrSource = stderr;
      this.stderrForwarder = forward;
    }
    transport.onmessage = (message, extra) => {
      this.onmessageValue?.(message, extra);
    };
    transport.onerror = (error) => {
      if (
        deferStartErrors &&
        this.stateValue === "starting" &&
        this.authorityValue === "none"
      ) {
        this.deferredRustStartError = error;
        return;
      }
      this.emitError(error);
    };
    transport.onclose = () => {
      if (this.closeRequested || this.stateValue === "closing") return;
      this.stateValue = "closed";
      this.notifyClose();
    };
  }

  private detach(transport: ManagedStdioTransport): void {
    if (this.stderrSource && this.stderrForwarder) {
      this.stderrSource.off("data", this.stderrForwarder);
      this.stderrSource = undefined;
      this.stderrForwarder = undefined;
    }
    transport.onmessage = undefined;
    transport.onerror = undefined;
    transport.onclose = undefined;
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.oncloseValue?.();
    } catch {
      // Lifecycle callbacks must not prevent transport cleanup.
    }
  }

  private emitError(error: Error): void {
    try {
      this.onerrorValue?.(error);
    } catch {
      // Lifecycle callbacks must not prevent transport cleanup.
    }
  }
}

export function classifyAdaptiveFallbackError(
  error: unknown,
): "disabled" | "connect" | "handshake" | "unavailable" | undefined {
  const code = errorCode(error);
  if (code === "DAEMON_DISABLED") return "disabled";
  if (code === "DAEMON_CONNECT_TIMEOUT") return "connect";
  if (code === "DAEMON_HANDSHAKE_TIMEOUT") return "handshake";
  if (code === "DAEMON_UNAVAILABLE") return "unavailable";

  const name = error instanceof Error ? error.name : "";
  if (name === "DaemonDisabledError") return "disabled";
  if (name === "DaemonTimeoutError") {
    const kind = errorKind(error);
    if (kind === "connect") return "connect";
    if (kind === "handshake") return "handshake";
  }
  if (name === "DaemonUnavailableError") return "unavailable";

  const cause = errorCause(error);
  return cause === undefined ? undefined : classifyAdaptiveFallbackError(cause);
}

export function shouldFallbackToSdk(
  error: unknown,
  rust: Pick<ManagedStdioTransport, "openDispatched">,
): boolean {
  return (
    !rust.openDispatched && classifyAdaptiveFallbackError(error) !== undefined
  );
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function errorKind(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { kind?: unknown }).kind;
  return typeof value === "string" ? value : undefined;
}

function errorCause(error: unknown): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as { cause?: unknown }).cause;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
