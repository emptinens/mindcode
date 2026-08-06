import { describe, expect, test } from "bun:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { RustStdioTransport } from "../../services/mcp/RustStdioTransport.js";
import { DaemonMcpStdioRpc, type McpStdioDaemonManager } from "./client.js";
import type {
  McpStdioCloseParams,
  McpStdioCloseResult,
  McpStdioOpenParams,
  McpStdioOpenResult,
  McpStdioReceiveParams,
  McpStdioReceiveResult,
  McpStdioRequestOptions,
  McpStdioRpc,
  McpStdioSendParams,
  McpStdioSendResult,
  McpStdioStatusParams,
  McpStdioStatusResult,
} from "./types.js";
import {
  McpStdioValidationError,
  validateMessage,
  validateOpenParams,
} from "./validation.js";

const request: JSONRPCMessage = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {},
};

class FakeRpc implements McpStdioRpc {
  readonly openCalls: McpStdioOpenParams[] = [];
  readonly openOptions: Array<McpStdioRequestOptions | undefined> = [];
  readonly sendCalls: McpStdioSendParams[] = [];
  readonly receiveCalls: Array<{
    params: McpStdioReceiveParams;
    options?: McpStdioRequestOptions;
  }> = [];
  closeCalls = 0;
  openError?: Error;
  openGate?: Promise<void>;
  dispatchOpen = true;
  receiveError?: Error;
  private readonly pending: Array<{
    resolve: (result: McpStdioReceiveResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  private readonly results: McpStdioReceiveResult[] = [];

  async open(
    params: McpStdioOpenParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioOpenResult> {
    this.openCalls.push(params);
    this.openOptions.push(options);
    if (this.dispatchOpen) options?.onDispatch?.();
    await this.openGate;
    if (this.openError) throw this.openError;
    return { connection_id: params.connection_id, pid: 4321 };
  }

  async send(params: McpStdioSendParams): Promise<McpStdioSendResult> {
    this.sendCalls.push(params);
    return { accepted: true };
  }

  async receive(
    params: McpStdioReceiveParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioReceiveResult> {
    this.receiveCalls.push({ params, options });
    if (this.receiveError) throw this.receiveError;
    const result = this.results.shift();
    if (result) return result;
    return new Promise<McpStdioReceiveResult>((resolve, reject) => {
      this.pending.push({ resolve, reject });
      options?.signal?.addEventListener(
        "abort",
        () => reject(new Error("receive aborted")),
        { once: true },
      );
    });
  }

  async close(_params: McpStdioCloseParams): Promise<McpStdioCloseResult> {
    this.closeCalls += 1;
    this.release({ message: null, closed: true });
    return { closed: true };
  }

  async status(_params: McpStdioStatusParams): Promise<McpStdioStatusResult> {
    return { connections: [] };
  }

  queue(result: McpStdioReceiveResult): void {
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve(result);
    else this.results.push(result);
  }

  fail(error: Error): void {
    const waiter = this.pending.shift();
    if (waiter) waiter.reject(error);
    else this.receiveError = error;
  }

  private release(result: McpStdioReceiveResult): void {
    const waiter = this.pending.shift();
    if (waiter) waiter.resolve(result);
  }
}

describe("MCP stdio validation", () => {
  test("requires an absolute POSIX or Windows cwd and rejects controls", () => {
    expect(() =>
      validateOpenParams({
        connection_id: "c1",
        command: "server",
        args: [],
        cwd: "relative/path",
      }),
    ).toThrow(McpStdioValidationError);
    expect(() =>
      validateOpenParams({
        connection_id: "c1",
        command: "server",
        args: [],
        cwd: "C:\\work\n",
      }),
    ).toThrow(McpStdioValidationError);
    expect(
      validateOpenParams({
        connection_id: "c1",
        command: "server",
        args: [],
        cwd: "C:\\work",
      }).cwd,
    ).toBe("C:\\work");
  });

  test("requires JSON-RPC 2.0 envelopes and rejects mixed result/error", () => {
    expect(() => validateMessage({ arbitrary: true })).toThrow(
      McpStdioValidationError,
    );
    expect(() =>
      validateMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -1, message: "failed" },
      }),
    ).toThrow(McpStdioValidationError);
    expect(
      validateMessage({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -1, message: "failed" },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -1, message: "failed" },
    });
    for (const id of [1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        validateMessage({ jsonrpc: "2.0", id, method: "request" }),
      ).toThrow(McpStdioValidationError);
      expect(() =>
        validateMessage({ jsonrpc: "2.0", id, result: null }),
      ).toThrow(McpStdioValidationError);
    }
  });

  test("forbids credential environment keys", () => {
    for (const key of ["VEXZY_API_KEY", "Authorization", "authorization"]) {
      expect(() =>
        validateOpenParams({
          connection_id: "c1",
          command: "server",
          args: [],
          cwd: "/tmp",
          env: { [key]: "secret" },
        }),
      ).toThrow(McpStdioValidationError);
    }

    const oversized = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [
        `SAFE_${index}`,
        "x".repeat(32_768),
      ]),
    );
    expect(() =>
      validateOpenParams({
        connection_id: "c1",
        command: "server",
        args: [],
        cwd: "/tmp",
        env: oversized,
      }),
    ).toThrow(McpStdioValidationError);
  });
});

describe("DaemonMcpStdioRpc", () => {
  test("passes daemon cancellation and timeout options without fallback", async () => {
    const calls: Array<{ method: string; options: unknown }> = [];
    const manager = {
      requestWithFallback: async <T>(
        method: string,
        _params: unknown,
        fallback: T,
        options: unknown,
      ) => {
        calls.push({ method, options });
        return {
          source: "daemon" as const,
          value: {
            message: null,
            closed: false,
          } as T,
        };
      },
    };
    const rpc = new DaemonMcpStdioRpc(
      manager as unknown as McpStdioDaemonManager,
    );
    const controller = new AbortController();
    const onDispatch = () => undefined;
    await rpc.receive(
      { connection_id: "c1", timeout_ms: 1000 },
      { signal: controller.signal, timeoutMs: 2000, onDispatch },
    );
    expect(calls).toEqual([
      {
        method: "mcp.stdio.receive",
        options: { signal: controller.signal, timeoutMs: 2000, onDispatch },
      },
    ]);
  });
});

describe("RustStdioTransport", () => {
  test("delivers FIFO messages without an MCP handshake", async () => {
    const rpc = new FakeRpc();
    const transport = new RustStdioTransport(
      {
        command: "server",
        args: [],
        cwd: "/tmp",
      },
      { rpc, receiveTimeoutMs: 1000 },
    );
    const received: JSONRPCMessage[] = [];
    transport.onmessage = (message) => received.push(message);
    await transport.start();
    rpc.queue({ message: request, closed: false });
    rpc.queue({
      message: { jsonrpc: "2.0", id: 1, result: { ok: true } },
      closed: false,
    });
    await Bun.sleep(0);
    await transport.close();
    expect(received).toEqual([
      request,
      { jsonrpc: "2.0", id: 1, result: { ok: true } },
    ]);
    expect(rpc.sendCalls).toHaveLength(0);
  });

  test("sends messages and exposes the stable daemon pid", async () => {
    const rpc = new FakeRpc();
    const transport = new RustStdioTransport(
      {
        command: "server",
        args: [],
        cwd: "/tmp",
      },
      { rpc },
    );
    await transport.start();
    const connectionId = transport.connectionId;
    await transport.send(request);
    expect(transport.connectionId).toBe(connectionId);
    expect(transport.pid).toBe(4321);
    expect(rpc.sendCalls[0]).toMatchObject({
      connection_id: connectionId,
      message: request,
    });
    await transport.close();
  });

  test("preserves receive cancellation and closes exactly once under a close race", async () => {
    const rpc = new FakeRpc();
    const transport = new RustStdioTransport(
      {
        command: "server",
        args: [],
        cwd: "/tmp",
      },
      { rpc },
    );
    let closeNotifications = 0;
    transport.onclose = () => {
      closeNotifications += 1;
    };
    await transport.start();
    const firstReceive = rpc.receiveCalls[0];
    const closing = Promise.all([
      transport.close(),
      transport.close(),
      transport.close(),
    ]);
    await closing;
    expect(firstReceive?.options?.signal?.aborted).toBe(true);
    expect(rpc.closeCalls).toBe(1);
    expect(closeNotifications).toBe(1);
  });

  test("reports server close and receive errors", async () => {
    const closedRpc = new FakeRpc();
    closedRpc.queue({ message: null, closed: true });
    const closedTransport = new RustStdioTransport(
      { command: "server", cwd: "/tmp" },
      { rpc: closedRpc },
    );
    let serverClosed = 0;
    closedTransport.onclose = () => {
      serverClosed += 1;
    };
    await closedTransport.start();
    await Bun.sleep(0);
    expect(serverClosed).toBe(1);

    const errorRpc = new FakeRpc();
    const error = new Error("receive failed");
    const errorTransport = new RustStdioTransport(
      { command: "server", cwd: "/tmp" },
      { rpc: errorRpc },
    );
    let errors = 0;
    let errorsClosed = 0;
    errorTransport.onerror = (reported) => {
      if (reported === error) errors += 1;
    };
    errorTransport.onclose = () => {
      errorsClosed += 1;
    };
    await errorTransport.start();
    errorRpc.fail(error);
    await Bun.sleep(0);
    expect(errors).toBe(1);
    expect(errorsClosed).toBe(1);
  });

  test("does not restart after an ambiguous open", async () => {
    const rpc = new FakeRpc();
    rpc.openError = new Error("open timeout");
    const transport = new RustStdioTransport(
      { command: "server", cwd: "/tmp" },
      { rpc },
    );
    await expect(transport.start()).rejects.toThrow("open timeout");
    await expect(transport.start()).rejects.toThrow("cannot be restarted");
    expect(rpc.openCalls).toHaveLength(1);
    await transport.close();
    expect(rpc.closeCalls).toBe(1);
  });

  test("keeps pre-dispatch failures eligible for adaptive fallback", async () => {
    const rpc = new FakeRpc();
    rpc.dispatchOpen = false;
    rpc.openError = Object.assign(new Error("daemon unavailable"), {
      code: "DAEMON_UNAVAILABLE",
    });
    const transport = new RustStdioTransport(
      { command: "server", cwd: "/tmp" },
      { rpc },
    );

    await expect(transport.start()).rejects.toThrow("daemon unavailable");
    expect(transport.openDispatched).toBe(false);
    await transport.close();
    expect(rpc.closeCalls).toBe(0);
  });

  test("cancels an in-flight open before issuing idempotent cleanup", async () => {
    const rpc = new FakeRpc();
    let releaseOpen!: () => void;
    rpc.openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    const transport = new RustStdioTransport(
      { command: "server", cwd: "/tmp" },
      { rpc },
    );

    const start = transport.start();
    await Bun.sleep(0);
    const close = transport.close();
    await Bun.sleep(0);
    expect(rpc.openOptions[0]?.signal?.aborted).toBe(true);
    releaseOpen();
    await start;
    await close;
    expect(rpc.closeCalls).toBe(1);
  });
});
