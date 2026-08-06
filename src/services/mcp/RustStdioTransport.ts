import { randomUUID } from "node:crypto";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DaemonMcpStdioRpc,
  type McpStdioDaemonManager,
} from "../../runtime/mcpStdio/client.js";
import type {
  McpStdioRpc,
  McpStdioServerParameters,
} from "../../runtime/mcpStdio/types.js";
import { MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS } from "../../runtime/mcpStdio/types.js";
import {
  normalizeServerParameters,
  validateMessage,
} from "../../runtime/mcpStdio/validation.js";

export type RustStdioTransportOptions = {
  daemonManager?: McpStdioDaemonManager;
  rpc?: McpStdioRpc;
  receiveTimeoutMs?: number;
  beforeOpen?: () => void | Promise<void>;
};

export type RustStdioTransportState =
  | "new"
  | "starting"
  | "running"
  | "closing"
  | "closed"
  | "failed";

/**
 * MCP client transport backed by the Rust daemon's mcp.stdio.* RPC methods.
 * The daemon owns the child process; this class owns only the connection ID,
 * receive loop, and lifecycle callbacks.
 */
export class RustStdioTransport implements Transport {
  private readonly server: McpStdioServerParameters & {
    args: string[];
    cwd: string;
  };
  private readonly rpc: McpStdioRpc;
  private readonly receiveTimeoutMs: number;
  private readonly beforeOpen?: () => void | Promise<void>;
  private readonly connectionIdValue: string;
  private stateValue: RustStdioTransportState = "new";
  private pidValue: number | null = null;
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private receivePromise?: Promise<void>;
  private receiveAbortController?: AbortController;
  private openAbortController?: AbortController;
  private openAttempted = false;
  private openDispatchedValue = false;
  private daemonConnectionOpen = false;
  private daemonConnectionEnded = false;
  private daemonCloseAttempted = false;
  private closeNotified = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(
    server: McpStdioServerParameters,
    options: RustStdioTransportOptions = {},
  ) {
    this.server = normalizeServerParameters(server);
    this.rpc = options.rpc ?? new DaemonMcpStdioRpc(options.daemonManager);
    this.receiveTimeoutMs = boundedReceiveTimeout(options.receiveTimeoutMs);
    this.beforeOpen = options.beforeOpen;
    this.connectionIdValue = randomUUID();
  }

  get connectionId(): string {
    return this.connectionIdValue;
  }

  get pid(): number | null {
    return this.pidValue;
  }

  get state(): RustStdioTransportState {
    return this.stateValue;
  }

  /** True once the daemon open RPC has been handed to the RPC implementation. */
  get openDispatched(): boolean {
    return this.openDispatchedValue;
  }

  async start(): Promise<void> {
    if (this.stateValue === "running") {
      throw new Error("RustStdioTransport already started");
    }
    if (this.startPromise) return this.startPromise;
    if (this.stateValue !== "new" || this.openAttempted) {
      throw new Error("RustStdioTransport cannot be restarted");
    }

    this.stateValue = "starting";
    this.openAttempted = true;
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
    _options?: TransportSendOptions,
  ): Promise<void> {
    if (this.stateValue !== "running") {
      throw new Error("RustStdioTransport is not running");
    }
    const validated = validateMessage(message);
    // TransportSendOptions contains relatedRequestId/resumption metadata, but
    // it does not carry an AbortSignal. Daemon send has no transport-level
    // cancellation signal to preserve.
    await this.rpc.send({
      connection_id: this.connectionIdValue,
      message: validated,
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    const promise = this.closeInternal();
    this.closePromise = promise;
    return promise;
  }

  private async startInternal(): Promise<void> {
    try {
      await this.beforeOpen?.();
      const openAbortController = new AbortController();
      this.openAbortController = openAbortController;
      const result = await this.rpc.open(
        {
          connection_id: this.connectionIdValue,
          command: this.server.command,
          args: [...this.server.args],
          cwd: this.server.cwd,
          ...(this.server.env === undefined
            ? {}
            : { env: { ...this.server.env } }),
        },
        {
          signal: openAbortController.signal,
          onDispatch: () => {
            this.openDispatchedValue = true;
          },
        },
      );
      // Custom RPC implementations predating onDispatch can still return a
      // successful open result; success is necessarily post-dispatch.
      this.openDispatchedValue = true;
      if (result.connection_id !== this.connectionIdValue) {
        throw new Error("Rust daemon returned a different connection_id");
      }
      this.pidValue = result.pid;
      this.daemonConnectionOpen = true;
      this.receiveAbortController = new AbortController();
      this.stateValue = "running";
      this.receivePromise = this.receiveLoop(
        this.receiveAbortController.signal,
      );
      void this.receivePromise.catch(() => undefined);
    } catch (error) {
      this.stateValue = "failed";
      const normalized = toError(error);
      this.notifyError(normalized);
      throw normalized;
    } finally {
      this.openAbortController = undefined;
    }
  }

  private async closeInternal(): Promise<void> {
    this.stateValue = "closing";
    this.openAbortController?.abort();
    if (this.startPromise) await this.startPromise.catch(() => undefined);

    this.receiveAbortController?.abort();
    const receivePromise = this.receivePromise;
    let closeError: unknown;
    if (
      this.openDispatchedValue &&
      !this.daemonConnectionEnded &&
      !this.daemonCloseAttempted
    ) {
      this.daemonCloseAttempted = true;
      try {
        await this.rpc.close({ connection_id: this.connectionIdValue });
      } catch (error) {
        closeError = error;
        this.notifyError(toError(error));
      }
    }
    await receivePromise?.catch(() => undefined);
    this.finishClose();
    if (closeError !== undefined) throw toError(closeError);
  }

  private async receiveLoop(signal: AbortSignal): Promise<void> {
    while (this.stateValue === "running" && !signal.aborted) {
      try {
        const result = await this.rpc.receive(
          {
            connection_id: this.connectionIdValue,
            timeout_ms: this.receiveTimeoutMs,
          },
          { signal, timeoutMs: this.receiveTimeoutMs + 1_000 },
        );
        if (signal.aborted || this.stateValue !== "running") return;
        if (result.closed) {
          this.daemonConnectionEnded = true;
          this.daemonConnectionOpen = false;
          this.stateValue = "closed";
          this.notifyClose();
          return;
        }
        if (result.message === null) continue;
        try {
          this.onmessage?.(result.message);
        } catch (error) {
          this.notifyError(toError(error));
        }
      } catch (error) {
        if (signal.aborted || this.stateValue !== "running") {
          return;
        }
        this.stateValue = "failed";
        this.notifyError(toError(error));
        this.notifyClose();
        return;
      }
    }
  }

  private finishClose(): void {
    this.stateValue = "closed";
    this.daemonConnectionOpen = false;
    this.daemonConnectionEnded = true;
    this.receiveAbortController?.abort();
    this.receiveAbortController = undefined;
    this.receivePromise = undefined;
    this.notifyClose();
  }

  private notifyError(error: Error): void {
    try {
      this.onerror?.(error);
    } catch {
      // Transport callbacks must not break lifecycle cleanup.
    }
  }

  private notifyClose(): void {
    if (this.closeNotified) return;
    this.closeNotified = true;
    try {
      this.onclose?.();
    } catch {
      // Transport callbacks must not break lifecycle cleanup.
    }
  }
}

function boundedReceiveTimeout(value: number | undefined): number {
  if (value === undefined) return MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("receiveTimeoutMs must be a positive integer");
  }
  return Math.min(value, MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS);
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
