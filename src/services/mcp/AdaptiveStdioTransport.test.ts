import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
} from "@modelcontextprotocol/sdk/types.js";
import {
  AdaptiveStdioTransport,
  classifyAdaptiveFallbackError,
  shouldFallbackToSdk,
} from "./AdaptiveStdioTransport.js";

class FakeTransport implements Transport {
  readonly name: string;
  readonly openDispatched: boolean;
  readonly ownsProcess: boolean;
  readonly stderr?: PassThrough;
  startError?: Error;
  startGate?: Promise<void>;
  startCalls = 0;
  closeCalls = 0;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  constructor(
    name: string,
    options: { openDispatched?: boolean; ownsProcess?: boolean } = {},
  ) {
    this.name = name;
    this.openDispatched = options.openDispatched ?? false;
    this.ownsProcess = options.ownsProcess ?? name === "sdk";
  }

  async start(): Promise<void> {
    this.startCalls += 1;
    await this.startGate;
    if (this.startError) {
      this.onerror?.(this.startError);
      throw this.startError;
    }
  }

  async send(
    _message: JSONRPCMessage,
    _options?: TransportSendOptions,
  ): Promise<void> {}

  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

const server = { command: "mcp-server", cwd: "/tmp" };

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe("adaptive MCP stdio transport", () => {
  test("classifies only pre-dispatch daemon readiness failures", () => {
    expect(classifyAdaptiveFallbackError({ code: "DAEMON_DISABLED" })).toBe(
      "disabled",
    );
    expect(
      classifyAdaptiveFallbackError({ code: "DAEMON_CONNECT_TIMEOUT" }),
    ).toBe("connect");
    expect(
      classifyAdaptiveFallbackError({ code: "DAEMON_HANDSHAKE_TIMEOUT" }),
    ).toBe("handshake");
    expect(classifyAdaptiveFallbackError({ code: "DAEMON_UNAVAILABLE" })).toBe(
      "unavailable",
    );
    expect(classifyAdaptiveFallbackError({ code: "DAEMON_DISCONNECTED" })).toBe(
      undefined,
    );
    expect(
      shouldFallbackToSdk(
        { code: "DAEMON_UNAVAILABLE" },
        { openDispatched: false },
      ),
    ).toBe(true);
    expect(
      shouldFallbackToSdk(
        { code: "DAEMON_UNAVAILABLE" },
        { openDispatched: true },
      ),
    ).toBe(false);
  });

  test("falls back before open dispatch and pins SDK authority", async () => {
    const rust = new FakeTransport("rust");
    rust.startError = Object.assign(new Error("daemon unavailable"), {
      code: "DAEMON_UNAVAILABLE",
    });
    const sdk = new FakeTransport("sdk");
    const transport = new AdaptiveStdioTransport(server, {
      daemonReady: async () => undefined,
      rustFactory: () => rust,
      sdkFactory: () => sdk,
    });
    const errors: Error[] = [];
    transport.onerror = (error) => errors.push(error);

    await transport.start();
    expect(transport.authority).toBe("sdk");
    expect(rust.startCalls).toBe(1);
    expect(sdk.startCalls).toBe(1);
    expect(errors).toEqual([]);
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    await transport.close();
    expect(transport.authority).toBe("sdk");
    expect(rust.closeCalls).toBe(1);
    expect(sdk.closeCalls).toBe(1);
  });

  test("exposes stderr before start and forwards SDK fallback output", async () => {
    const rust = new FakeTransport("rust");
    rust.startError = Object.assign(new Error("daemon unavailable"), {
      code: "DAEMON_UNAVAILABLE",
    });
    const sdk = new FakeTransport("sdk");
    Object.defineProperty(sdk, "stderr", { value: new PassThrough() });
    const transport = new AdaptiveStdioTransport(server, {
      rustFactory: () => rust,
      sdkFactory: () => sdk,
    });
    const chunks: string[] = [];
    transport.stderr?.on("data", (chunk) => chunks.push(String(chunk)));

    await transport.start();
    sdk.stderr?.write("sdk stderr");
    await Promise.resolve();

    expect(chunks).toEqual(["sdk stderr"]);
    await transport.close();
  });

  test("pins Rust authority and never falls back after a successful start", async () => {
    const rust = new FakeTransport("rust", { openDispatched: true });
    const sdk = new FakeTransport("sdk");
    const transport = new AdaptiveStdioTransport(server, {
      rustFactory: () => rust,
      sdkFactory: () => sdk,
    });

    await transport.start();
    expect(transport.authority).toBe("rust");
    rust.onclose?.();
    expect(sdk.startCalls).toBe(0);
    expect(transport.authority).toBe("rust");
    await transport.close();
    expect(rust.closeCalls).toBe(1);
    expect(sdk.closeCalls).toBe(0);
  });

  test("does not fall back when open dispatch already happened", async () => {
    const rust = new FakeTransport("rust", { openDispatched: true });
    rust.startError = Object.assign(new Error("daemon unavailable"), {
      code: "DAEMON_UNAVAILABLE",
    });
    const sdk = new FakeTransport("sdk");
    const transport = new AdaptiveStdioTransport(server, {
      rustFactory: () => rust,
      sdkFactory: () => sdk,
    });

    await expect(transport.start()).rejects.toThrow("daemon unavailable");
    expect(sdk.startCalls).toBe(0);
    expect(transport.authority).toBe("none");
    await transport.close();
    expect(rust.closeCalls).toBe(1);
  });

  test("serializes close with an in-flight start without spawning SDK", async () => {
    const gate = deferred();
    const rust = new FakeTransport("rust", { openDispatched: true });
    rust.startGate = gate.promise;
    const sdk = new FakeTransport("sdk");
    const transport = new AdaptiveStdioTransport(server, {
      rustFactory: () => rust,
      sdkFactory: () => sdk,
    });

    const start = transport.start();
    await Promise.resolve();
    const close = transport.close();
    gate.resolve();

    await expect(start).rejects.toThrow("closed during start");
    await close;
    expect(rust.closeCalls).toBe(1);
    expect(sdk.startCalls).toBe(0);
  });
});
