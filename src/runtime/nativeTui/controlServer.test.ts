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

  test("preserves every protocol v2 field when publishing a validated snapshot", async () => {
    const server = new NativeTuiControlServer({
      socketPath: resolveNativeTuiSocketPath(
        `test-${randomUUID()}`,
        "/tmp/mindcode-native-tui",
      ),
      sessionId: "session-1",
    });
    servers.push(server);
    const first = server.publish({ status: { state: "ready" } });
    const candidate = {
      ...first,
      sequence: first.sequence + 1,
      sessions: [
        {
          id: "session-1",
          name: "MindCode",
          workspace: "/workspace",
          status: "active",
          model: "gpt-5.6-luna",
          effort: "max",
          active: true,
          pinned: true,
          unread: 2,
          created_at_ms: 1,
          updated_at_ms: 2,
        },
      ],
      workspaces: [
        {
          id: "workspace-1",
          name: "workspace",
          path: "/workspace",
          active: true,
        },
      ],
      active_session_id: "session-1",
      telemetry: {
        ...first.telemetry,
        model: "gpt-5.6-luna",
        effort: "max",
        credits: 1.25,
        active_agents: 1,
      },
      agents: [
        {
          id: "agent-1",
          name: "Luna",
          role: "worker",
          status: "running",
          task_id: "task-1",
          model: "gpt-5.6-luna",
          effort: "max",
          progress: 50,
        },
      ],
      tasks: [
        {
          id: "task-1",
          title: "Integrate",
          status: "running",
          progress: 50,
          metadata: {
            agent_id: "agent-1",
            dependencies: [],
            blocked_by: [],
            files_touched: ["src/runtime/nativeTui/controlServer.ts"],
          },
        },
      ],
      transcript_window: {
        start_sequence: 1,
        end_sequence: 1,
        has_older: true,
        has_newer: false,
        blocks: [],
      },
      changes: [
        {
          path: "src/runtime/nativeTui/controlServer.ts",
          kind: "modified",
          additions: 1,
          deletions: 0,
          staged: false,
        },
      ],
      activity: [
        {
          id: "activity-1",
          timestamp_ms: 1,
          kind: "task",
          message: "running",
          task_id: "task-1",
          agent_id: "agent-1",
          severity: "info",
        },
      ],
      permissions: [
        {
          id: "permission-1",
          tool: "Bash",
          action: "run",
          resource: "bun test",
          reason: "verify",
          status: "pending",
          requested_at_ms: 1,
        },
      ],
      writer: {
        mode: "writer",
        writer_id: "client-1",
        observers: ["client-2"],
      },
    };

    expect(server.publishSnapshot(candidate)).toEqual(candidate);
  });

  test("accepts a client capability superset", async () => {
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
      encodeNativeTuiFrame(
        handshake("session-1", "mindcode-tui", [
          "render_snapshot",
          "input",
          "resize",
          "shutdown",
          "mouse",
          "action",
        ]),
      ),
    );
    await messages.waitFor(1);
    expect(messages.values[0]).toEqual({
      type: "capabilities",
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: "session-1",
      capabilities: [
        "render_snapshot",
        "input",
        "resize",
        "shutdown",
        "mouse",
        "action",
      ],
    });
    expect(server.connected).toBe(true);
  });

  test("negotiates only the server/client capability intersection", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      capabilities: [
        "render_snapshot",
        "input",
        "resize",
        "shutdown",
        "mouse",
        "server-only",
      ],
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(
      encodeNativeTuiFrame(
        handshake("session-1", "mindcode-tui", [
          "render_snapshot",
          "input",
          "resize",
          "shutdown",
          "mouse",
          "action",
          "client-only",
        ]),
      ),
    );
    await messages.waitFor(1);
    expect(messages.values[0]).toMatchObject({
      type: "capabilities",
      id: "session-1",
      capabilities: ["render_snapshot", "input", "resize", "shutdown", "mouse"],
    });
  });

  test("rejects mouse and action input when capabilities are not negotiated", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      capabilities: ["render_snapshot", "input", "resize", "shutdown"],
    });
    servers.push(server);
    await server.start();
    const client = await connect(socketPath);
    const messages = collectMessages(client);
    client.write(
      encodeNativeTuiFrame(
        handshake("session-1", "mindcode-tui", [
          "render_snapshot",
          "input",
          "resize",
          "shutdown",
          "mouse",
          "action",
        ]),
      ),
    );
    await messages.waitFor(1);
    client.write(
      Buffer.concat([
        encodeNativeTuiFrame({
          type: "input_event",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: "mouse-1",
          sequence: 1,
          event: {
            type: "mouse",
            x: 1,
            y: 2,
            button: "left",
            kind: "down",
            modifiers: [],
          },
        }),
        encodeNativeTuiFrame({
          type: "input_event",
          version: NATIVE_TUI_PROTOCOL_VERSION,
          id: "action-1",
          sequence: 2,
          event: { type: "action", action: "open" },
        }),
      ]),
    );
    await messages.waitFor(3);
    expect(messages.values.slice(1)).toEqual([
      expect.objectContaining({
        type: "error",
        id: "mouse-1",
        code: "capability_required",
        message: "Capability mouse was not negotiated",
      }),
      expect.objectContaining({
        type: "error",
        id: "action-1",
        code: "capability_required",
        message: "Capability action was not negotiated",
      }),
    ]);
    expect(server.connected).toBe(true);
  });

  test("replaces an idle pre-handshake socket for reconnect", async () => {
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
    const idle = await connect(socketPath);
    const reconnect = await connect(socketPath);
    const messages = collectMessages(reconnect);
    reconnect.write(encodeNativeTuiFrame(handshake("session-1")));
    await messages.waitFor(1);
    expect(messages.values[0]?.type).toBe("capabilities");
    expect(server.connected).toBe(true);
    await waitForClose(idle);
  });

  test("expires an idle handshake through a bounded timer", async () => {
    const socketPath = resolveNativeTuiSocketPath(
      `test-${randomUUID()}`,
      "/tmp/mindcode-native-tui",
    );
    const server = new NativeTuiControlServer({
      socketPath,
      sessionId: "session-1",
      handshakeTimeoutMs: 1,
    });
    servers.push(server);
    await server.start();
    const idle = await connect(socketPath);
    const state = Reflect.get(server, "outbound") as {
      handshakeTimer?: ReturnType<typeof setTimeout>;
    };
    expect(state.handshakeTimer).toBeDefined();
    const expireHandshake = Reflect.get(server, "expireHandshake") as (
      socket: Socket,
    ) => void;
    expireHandshake.call(server, idle);
    await waitForClose(idle);
    expect(server.connected).toBe(false);
  });

  test("keeps the Rust handshake server ID equal to the session ID", () => {
    expect(
      () =>
        new NativeTuiControlServer({
          socketPath: resolveNativeTuiSocketPath(
            `test-${randomUUID()}`,
            "/tmp/mindcode-native-tui",
          ),
          sessionId: "session-1",
          serverId: "server-1",
        }),
    ).toThrow("serverId must match sessionId");
  });

  test("bounds the handshake timeout configuration", () => {
    expect(
      () =>
        new NativeTuiControlServer({
          socketPath: resolveNativeTuiSocketPath(
            `test-${randomUUID()}`,
            "/tmp/mindcode-native-tui",
          ),
          handshakeTimeoutMs: 60_001,
        }),
    ).toThrow("handshakeTimeoutMs");
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
  capabilities = [
    "render_snapshot",
    "input",
    "resize",
    "shutdown",
    "mouse",
    "action",
  ],
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
