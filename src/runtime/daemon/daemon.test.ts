import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, type Socket, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient } from "./client.js";
import { DaemonCancelledError } from "./errors.js";
import { resolveDaemonSocketPath } from "./path.js";
import {
  DAEMON_PROTOCOL_VERSION,
  DaemonProtocolError,
  type DaemonWireMessage,
  FrameDecoder,
  encodeFrame,
} from "./protocol.js";
import { sanitizeDaemonEnvironment } from "./spawn.js";

const servers: FakeDaemon[] = [];
const clients: DaemonClient[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const server of servers.splice(0)) await server.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

class FakeDaemon {
  readonly server: Server;
  readonly received: DaemonWireMessage[] = [];
  private readonly sockets = new Set<Socket>();
  private readonly decoders = new Map<Socket, FrameDecoder>();
  socketPath = "";

  constructor() {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      this.decoders.set(socket, new FrameDecoder());
      socket.on("data", (chunk) => {
        const decoder = this.decoders.get(socket);
        if (!decoder) return;
        for (const message of decoder.push(chunk)) {
          this.received.push(message);
          this.handle(socket, message);
        }
      });
      socket.once("close", () => {
        this.sockets.delete(socket);
        this.decoders.delete(socket);
      });
    });
  }

  async listen(): Promise<void> {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-daemon-test-"));
    directories.push(directory);
    this.socketPath = join(directory, "mindcoded-v1.sock");
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.socketPath, resolve);
    });
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    if (!this.server.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  send(socket: Socket, message: DaemonWireMessage, fragmented = false): void {
    const frame = encodeFrame(message);
    if (!fragmented || frame.byteLength < 3) {
      socket.write(frame);
      return;
    }
    socket.write(frame.subarray(0, 2));
    setTimeout(() => socket.write(frame.subarray(2)), 1);
  }

  private handle(socket: Socket, message: DaemonWireMessage): void {
    if (message.type === "handshake") {
      this.send(
        socket,
        {
          type: "handshake_ack",
          id: message.id,
          version: DAEMON_PROTOCOL_VERSION,
          accepted: true,
          server: "fake-mindcoded",
        },
        true,
      );
      return;
    }
    if (message.type !== "request") return;
    if (message.method === "stream") {
      this.send(socket, {
        type: "stream",
        id: message.id,
        seq: 0,
        data: "one",
      });
      this.send(socket, {
        type: "stream",
        id: message.id,
        seq: 1,
        data: "two",
      });
      this.send(socket, {
        type: "response",
        id: message.id,
        ok: true,
        result: { done: true },
      });
      return;
    }
    if (message.method === "bad-stream") {
      this.send(socket, {
        type: "stream",
        id: message.id,
        seq: 1,
        data: "wrong",
      });
      return;
    }
    if (message.method === "hang") return;
    if (message.method === "drop") {
      socket.destroy();
      return;
    }
    this.send(socket, {
      type: "response",
      id: message.id,
      ok: true,
      result: message.method === "status" ? { ready: true } : { pong: true },
    });
  }
}

async function fakeClient(): Promise<{
  fake: FakeDaemon;
  client: DaemonClient;
}> {
  const fake = new FakeDaemon();
  await fake.listen();
  servers.push(fake);
  const client = new DaemonClient({
    socketPath: fake.socketPath,
    connectTimeoutMs: 1_000,
    handshakeTimeoutMs: 1_000,
    requestTimeoutMs: 500,
  });
  clients.push(client);
  return { fake, client };
}

describe("daemon protocol framing", () => {
  test("uses a 4-byte big-endian frame and accepts fragmented input", () => {
    const decoder = new FrameDecoder();
    const frame = encodeFrame({ type: "cancel", id: "request-1" });
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    expect(decoder.push(frame.subarray(0, 3))).toEqual([]);
    expect(decoder.push(frame.subarray(3))).toEqual([
      { type: "cancel", id: "request-1" },
    ]);
  });

  test("rejects frames over the configured maximum", () => {
    const decoder = new FrameDecoder(8);
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(9, 0);
    expect(() => decoder.push(oversized)).toThrow(DaemonProtocolError);
  });

  test.each([
    {
      type: "handshake_ack",
      id: "handshake-1",
      version: 2,
      accepted: true,
    },
    {
      type: "handshake_ack",
      id: "handshake-1",
      version: DAEMON_PROTOCOL_VERSION,
      accepted: true,
      capabilities: ["stream", 1],
    },
    {
      type: "response",
      id: "request-1",
      ok: true,
      error: { code: "bad", message: "contradictory response" },
    },
    {
      type: "response",
      id: "request-1",
      ok: false,
      error: { code: "bad" },
    },
    {
      type: "stream",
      id: "request-1",
      seq: 0.5,
      data: "chunk",
    },
    {
      type: "stream",
      id: "request-1",
      seq: 0,
    },
  ] as const)("rejects malformed $type frames", (message) => {
    const decoder = new FrameDecoder();
    expect(() =>
      decoder.push(encodeFrame(message as unknown as DaemonWireMessage)),
    ).toThrow(DaemonProtocolError);
  });
});

describe("DaemonClient", () => {
  test("performs v1 handshake and exposes ping/status", async () => {
    const { fake, client } = await fakeClient();
    await expect(client.ping()).resolves.toEqual({ pong: true });
    await expect(client.status()).resolves.toEqual({ ready: true });
    await expect(client.shutdown()).resolves.toEqual({ pong: true });
    expect(client.state).toBe("disconnected");
    expect(fake.received[0]).toMatchObject({ type: "handshake", version: 1 });
    expect(
      fake.received.filter((message) => message.type === "request"),
    ).toHaveLength(3);
  });

  test("validates stream sequence and returns the final response", async () => {
    const { client } = await fakeClient();
    const chunks: unknown[] = [];
    await expect(
      client.request("stream", undefined, {
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      }),
    ).resolves.toEqual({ done: true });
    expect(chunks).toEqual(["one", "two"]);
  });

  test("rejects an invalid sequence and sends cancellation", async () => {
    const { fake, client } = await fakeClient();
    await expect(
      client.request("bad-stream", undefined, { onChunk: () => {} }),
    ).rejects.toThrow(DaemonProtocolError);
    await Bun.sleep(50);
    expect(fake.received).toContainEqual({
      type: "cancel",
      id: expect.any(String),
    });
  });

  test("propagates AbortSignal cancellation to the daemon", async () => {
    const { fake, client } = await fakeClient();
    const controller = new AbortController();
    await client.connect();
    const pending = client.request("hang", undefined, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(DaemonCancelledError);
    await Bun.sleep(50);
    expect(fake.received).toContainEqual({
      type: "cancel",
      id: expect.any(String),
    });
  });

  test("rejects timed-out requests and emits cancellation", async () => {
    const { fake, client } = await fakeClient();
    await expect(
      client.request("hang", undefined, { timeoutMs: 20 }),
    ).rejects.toMatchObject({
      code: "DAEMON_REQUEST_TIMEOUT",
    });
    await Bun.sleep(50);
    expect(fake.received).toContainEqual({
      type: "cancel",
      id: expect.any(String),
    });
  });

  test("rejects all pending requests on disconnect and can reconnect", async () => {
    const { client } = await fakeClient();
    const pending = client.request("hang");
    await client.request("drop").catch(() => undefined);
    await expect(pending).rejects.toMatchObject({
      code: "DAEMON_DISCONNECTED",
    });
    expect(client.state).toBe("disconnected");
    await expect(client.ping()).resolves.toEqual({ pong: true });
  });

  test("returns a typed fallback result without spawning a daemon", async () => {
    const client = new DaemonClient({
      socketPath: join(tmpdir(), "missing-mindcoded.sock"),
      connectTimeoutMs: 10,
    });
    clients.push(client);
    await expect(
      client.requestWithFallback("status", undefined, { cached: true }),
    ).resolves.toMatchObject({
      source: "fallback",
      value: { cached: true },
    });
  });
});

describe("daemon paths", () => {
  test("uses the required default and supports the environment override", () => {
    expect(resolveDaemonSocketPath({})).toContain(
      ".mindcode/run/mindcoded-v1.sock",
    );
    expect(
      resolveDaemonSocketPath({ MINDCODE_DAEMON_SOCKET: "~/custom.sock" }),
    ).toMatch(/\/custom\.sock$/);
  });

  test("sanitizes daemon environment and drops secrets from overrides", () => {
    expect(
      sanitizeDaemonEnvironment(
        {
          PATH: "/bin",
          HOME: "/home/test",
          LANG: "en_US.UTF-8",
          LC_ALL: "C",
          MINDCODE_CONFIG_DIR: "/tmp/config",
          VEXZY_API_KEY: "secret",
          MINDCODE_API_TOKEN: "secret",
          UNRELATED_VALUE: "drop",
        },
        {
          TMPDIR: "/tmp/test",
          VEXZY_API_KEY: "override-secret",
          MINDCODE_SECRET: "override-secret",
          UNRELATED_OVERRIDE: "drop",
        },
      ),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/test",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      MINDCODE_CONFIG_DIR: "/tmp/config",
      TMPDIR: "/tmp/test",
    });
  });
});
