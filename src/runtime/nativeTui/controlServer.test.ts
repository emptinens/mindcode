import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { type Socket, createConnection } from "node:net";
import {
  NativeTuiControlServer,
  resolveNativeTuiSocketPath,
} from "./controlServer.js";
import {
  NATIVE_TUI_PROTOCOL_VERSION,
  NativeTuiFrameDecoder,
  type NativeTuiWireMessage,
  encodeNativeTuiFrame,
} from "./protocol.js";

const sockets: Socket[] = [];
const servers: NativeTuiControlServer[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.destroy();
  for (const server of servers.splice(0)) await server.close();
});

describe("native TUI control server", () => {
  test("creates a per-session 0600 Unix socket and exchanges frames", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
    });
    servers.push(server);
    await server.start();
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);

    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(
      encodeNativeTuiFrame({
        ...handshake("session-1"),
      }),
    );
    await messages.waitFor(1);
    expect(messages.values[0]?.type).toBe("capabilities");

    const snapshot = server.publish({
      status: { state: "ready", message: "ok" },
      tasks: [{ id: "task-1", title: "Task", status: "pending" }],
      transcript: [{ sequence: 1, role: "assistant", text: "hello" }],
    });
    await messages.waitFor(2);
    expect(messages.values[1]).toEqual(snapshot);
    expect(server.revision).toBe(1);
  });

  test("coalesces pending snapshots and waits for socket drain", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      maxOutboundQueueMessages: 2,
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(encodeNativeTuiFrame(handshake("session-1")));
    await messages.waitFor(1);

    const serverSocket = Reflect.get(server, "client") as Socket;
    const outbound = Reflect.get(server, "outbound") as {
      queue: Array<{ message: NativeTuiWireMessage }>;
    };
    const originalWrite = serverSocket.write;
    let releaseWrite: ((error?: Error | null) => void) | undefined;
    let blockedChunk: Uint8Array | undefined;
    serverSocket.write = ((
      chunk: Uint8Array,
      callback?: (error?: Error | null) => void,
    ) => {
      blockedChunk = chunk;
      releaseWrite = callback;
      return false;
    }) as typeof serverSocket.write;

    server.publish({ status: { state: "one" } });
    await Bun.sleep(0);
    const latest = server.publish({ status: { state: "two" } });
    server.publish({ status: { state: "three" } });
    expect(outbound.queue).toHaveLength(1);
    expect(outbound.queue[0]?.message).toMatchObject({
      type: "render_snapshot",
      sequence: latest.sequence + 1,
      status: { state: "three" },
    });
    expect(messages.values).toHaveLength(1);

    const write = originalWrite.bind(serverSocket);
    serverSocket.write = originalWrite;
    if (!blockedChunk || !releaseWrite)
      throw new Error("write was not blocked");
    const callback = releaseWrite;
    write(blockedChunk, (error?: Error | null) => callback(error));
    serverSocket.emit("drain");
    await messages.waitFor(3);
    expect(messages.values.at(-1)).toMatchObject({
      type: "render_snapshot",
      status: { state: "three" },
    });
  });

  test("accepts one ordered input client and acknowledges intents", async () => {
    const seen: number[] = [];
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      onInput: async (event) => {
        await Bun.sleep(event.sequence === 1 ? 5 : 0);
        seen.push(event.sequence);
      },
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(
      encodeNativeTuiFrame({
        ...handshake("session-1"),
      }),
    );
    await messages.waitFor(1);
    client.write(
      Buffer.concat([
        encodeNativeTuiFrame({
          type: "input_event",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: "input-1",
          sequence: 1,
          event: { type: "submit" },
        }),
        encodeNativeTuiFrame({
          type: "input_event",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: "input-2",
          sequence: 2,
          event: { type: "cancel" },
        }),
      ]),
    );
    await messages.waitFor(3);
    expect(seen).toEqual([1, 2]);
    expect(messages.values.slice(1).map((message) => message.type)).toEqual([
      "ack",
      "ack",
    ]);
  });

  test("awaits onBeforeConnect before the handshake response and keeps onConnect after it", async () => {
    const events: string[] = [];
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      onBeforeConnect: async () => {
        await Bun.sleep(5);
        events.push("before");
      },
      onConnect: () => {
        events.push("connect");
      },
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(encodeNativeTuiFrame(handshake("session-1")));
    await messages.waitFor(1);
    expect(messages.values[0]?.type).toBe("capabilities");
    expect(events).toEqual(["before", "connect"]);
  });

  test("strictly validates session, client, and capability values", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(
      encodeNativeTuiFrame(handshake("wrong-session", "mindcode-tui")),
    );
    await messages.waitFor(1);
    expect(messages.values[0]).toMatchObject({
      type: "error",
      code: "handshake_rejected",
    });
    await waitForClose(client);
    expect(server.connected).toBe(false);
  });

  test("rejects duplicate snapshot revisions instead of sending them", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(encodeNativeTuiFrame(handshake("session-1")));
    await messages.waitFor(1);

    const first = server.publish({ status: { state: "ready" } });
    await messages.waitFor(2);
    expect(messages.values[1]).toEqual(first);

    expect(() => server.publishSnapshot(first)).toThrow(
      "Snapshot revision is not monotonic",
    );
    await Bun.sleep(10);
    expect(messages.values).toHaveLength(2);
  });

  test("rejects a second connected client while retaining the first", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
    });
    servers.push(server);
    await server.start();
    const first = await connect(socketPath);
    const firstMessages = collectMessages(first);
    first.write(encodeNativeTuiFrame({ ...handshake("session-1") }));
    await firstMessages.waitFor(1);
    const second = await connect(socketPath);
    sockets.push(second);
    if (!second.destroyed) {
      await new Promise<void>((resolve) =>
        second.once("close", () => resolve()),
      );
    }
    expect(server.connected).toBe(true);
    sockets.push(first);
  });
});

function handshake(
  id: string,
  client = "mindcode-tui",
  capabilities = ["render_snapshot", "input", "resize", "shutdown"],
): NativeTuiWireMessage {
  return {
    type: "handshake",
    version: NATIVE_TUI_PROTOCOL_VERSION,
    id,
    client,
    capabilities,
  };
}

async function waitForClose(socket: Socket): Promise<void> {
  if (socket.destroyed) return;
  await new Promise<void>((resolve) => socket.once("close", () => resolve()));
}

async function connect(path: string): Promise<Socket> {
  const socket = createConnection(path);
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
  return socket;
}

function collectMessages(socket: Socket): {
  values: NativeTuiWireMessage[];
  waitFor: (count: number) => Promise<void>;
} {
  const decoder = new NativeTuiFrameDecoder();
  const values: NativeTuiWireMessage[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  socket.on("data", (chunk) => {
    values.push(...decoder.push(chunk));
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter && values.length >= waiter.count) {
        waiters.splice(index, 1);
        waiter.resolve();
      }
    }
  });
  return {
    values,
    waitFor: (count) => {
      if (values.length >= count) return Promise.resolve();
      return new Promise<void>((resolve) => waiters.push({ count, resolve }));
    },
  };
}
