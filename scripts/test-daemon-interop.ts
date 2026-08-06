import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../src/runtime/daemon/client.js";
import {
  DAEMON_PROTOCOL_VERSION,
  encodeFrame,
  FrameDecoder,
  type DaemonWireMessage,
} from "../src/runtime/daemon/protocol.js";
import { SessionIndexDaemonClient } from "../src/runtime/sessionIndex/client.js";
import { TaskGraphDaemonClient } from "../src/runtime/taskGraph/client.js";

const root = resolve(import.meta.dirname, "..");
const executable =
  process.env.MINDCODE_DAEMON_PATH ??
  join(root, "target", "debug", "mindcoded");
const directory = await mkdtemp(join(tmpdir(), "mindcoded-interop-"));
const socketPath = join(directory, "mindcoded-v1.sock");
const stateDirectory = join(directory, "state");
let stderr = "";
const child = spawn(
  executable,
  [
    "--socket",
    socketPath,
    "--state-dir",
    stateDirectory,
    "--idle-seconds",
    "60",
    "--build-id",
    "ts-interop",
  ],
  { stdio: ["ignore", "ignore", "pipe"] },
);
child.stderr?.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForSocket(socketPath, 3_000);
  const client = new DaemonClient({ socketPath });
  const ping = await client.ping();
  const status = await client.status();
  if (ping.pong !== true || status.build_id !== "ts-interop") {
    throw new Error(
      `unexpected daemon response: ${JSON.stringify({ ping, status })}`,
    );
  }

  const graph = new TaskGraphDaemonClient(client);
  const routed = await graph.route({
    id: "interop-task",
    effort: "high",
    files_touched: ["src/interop.ts"],
  });
  if (!routed.created || routed.task?.effort !== "high") {
    throw new Error(`unexpected route response: ${JSON.stringify(routed)}`);
  }
  const read = await graph.read("interop-task");
  if (read.task?.status !== "pending")
    throw new Error(`unexpected read response: ${JSON.stringify(read)}`);
  const listed = await graph.list({ status: "pending", limit: 10, offset: 0 });
  if (!listed.tasks.some((task) => task.id === "interop-task"))
    throw new Error(`unexpected list response: ${JSON.stringify(listed)}`);
  const dependents = await graph.listDependents("interop-task");
  if (!Array.isArray(dependents.tasks))
    throw new Error(
      `unexpected dependents response: ${JSON.stringify(dependents)}`,
    );
  const claimed = await graph.claim("interop-task", {
    owner: "gpt-5.6-luna",
    lease_id: "interop-lease",
    now: "2026-08-06T00:00:00.000Z",
  });
  if (!claimed.ok) {
    throw new Error(`unexpected claim response: ${JSON.stringify(claimed)}`);
  }
  const renewed = await graph.renewLease("interop-lease", {
    owner: "gpt-5.6-luna",
    ttl_ms: 1_000,
    now: "2026-08-06T00:00:00.000Z",
  });
  if (renewed.lease?.lease_id !== "interop-lease")
    throw new Error(`unexpected renew response: ${JSON.stringify(renewed)}`);
  const released = await graph.releaseLease("interop-lease", {
    owner: "gpt-5.6-luna",
    now: "2026-08-06T00:00:01.000Z",
  });
  if (released.lease?.released_at !== "2026-08-06T00:00:01.000Z")
    throw new Error(`unexpected release response: ${JSON.stringify(released)}`);
  const pending = await graph.read("interop-task");
  if (!pending.task) throw new Error("task disappeared after lease release");
  const completed = await graph.update(
    claimed.task.id,
    { status: "completed", report_id: "interop-report" },
    pending.task.version,
  );
  const recovered = await graph.recover("2026-08-06T00:00:02.000Z");
  if (!Array.isArray(recovered.tasks))
    throw new Error(
      `unexpected recover response: ${JSON.stringify(recovered)}`,
    );
  const snapshot = await graph.snapshot();
  if (
    completed.task.report_id !== "interop-report" ||
    !snapshot.tasks.some((task) => task.id === "interop-task")
  ) {
    throw new Error(
      `unexpected task graph response: ${JSON.stringify({ completed, snapshot })}`,
    );
  }

  const sessions = new SessionIndexDaemonClient(client);
  const session = {
    session_id: "10000000-0000-4000-8000-000000000001",
    project_path: "/work/project",
    transcript_path:
      "/state/projects/work-project/10000000-0000-4000-8000-000000000001.jsonl",
    modified_at_ms: 1_759_478_400_000,
    size_bytes: 42,
    title: "Interop session",
    first_prompt: "Inspect the project",
  };
  const upserted = await sessions.upsert(session);
  const indexed = await sessions.get(session.session_id);
  const sessionList = await sessions.list({
    project_path: session.project_path,
    limit: 10,
  });
  const sessionSearch = await sessions.search({
    query: "inspect",
    project_path: session.project_path,
    limit: 10,
  });
  if (
    upserted.session.session_id !== session.session_id ||
    indexed.session?.title !== session.title ||
    !sessionList.sessions.some(
      (entry) => entry.session_id === session.session_id,
    ) ||
    !sessionSearch.sessions.some(
      (entry) => entry.session_id === session.session_id,
    )
  ) {
    throw new Error(
      `unexpected session index response: ${JSON.stringify({
        upserted,
        indexed,
        sessionList,
        sessionSearch,
      })}`,
    );
  }
  const removedSession = await sessions.remove(session.session_id);
  if (
    !removedSession.removed ||
    (await sessions.get(session.session_id)).session !== null
  ) {
    throw new Error(
      `session index remove failed: ${JSON.stringify(removedSession)}`,
    );
  }
  await assertInvalidParams(client, "task_graph.recover", { now: 123 });
  await assertInvalidParams(client, "task_graph.snapshot", {
    unexpected: true,
  });

  await testMutationReplay(socketPath);
  await client.shutdown();
  const exitCode = await waitForExit(child, 3_000);
  if (exitCode !== 0)
    throw new Error(`mindcoded exited ${exitCode}: ${stderr}`);
  process.stdout.write(
    "Rust/TypeScript daemon + TaskGraph + SessionIndex interoperability: PASS\n",
  );
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}

async function assertInvalidParams(
  client: DaemonClient,
  method: string,
  params: unknown,
): Promise<void> {
  try {
    await client.request(method, params);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "remoteCode" in error &&
      (error as { remoteCode?: unknown }).remoteCode === "INVALID_PARAMS"
    ) {
      return;
    }
    throw error;
  }
  throw new Error(`${method} unexpectedly accepted invalid params`);
}

async function testMutationReplay(socketPath: string): Promise<void> {
  const params = {
    task: { id: "interop-replay-task", files_touched: ["src/replay.ts"] },
    mode: "block",
  };
  const firstConnection = await RawConnection.open(socketPath, "raw-first");
  const first = await firstConnection.request(
    "replay-request",
    "task_graph.route",
    params,
  );
  if (!first.ok || (first.result as { created?: unknown })?.created !== true)
    throw new Error(
      `unexpected first replay response: ${JSON.stringify(first)}`,
    );
  firstConnection.close();

  const secondConnection = await RawConnection.open(socketPath, "raw-second");
  const replay = await secondConnection.request(
    "replay-request",
    "task_graph.route",
    params,
  );
  if (JSON.stringify(replay) !== JSON.stringify(first))
    throw new Error(
      `mutation replay mismatch: ${JSON.stringify({ first, replay })}`,
    );
  const reuse = await secondConnection.request(
    "replay-request",
    "task_graph.route",
    { task: { id: "different-replay-task", files_touched: [] }, mode: "block" },
  );
  if (reuse.ok || reuse.error?.code !== "request_id_reuse")
    throw new Error(
      `request id reuse was not rejected: ${JSON.stringify(reuse)}`,
    );
  const invalidRecover = await secondConnection.request(
    "raw-invalid-recover",
    "task_graph.recover",
    { now: 123 },
  );
  if (invalidRecover.ok || invalidRecover.error?.code !== "INVALID_PARAMS")
    throw new Error(
      `invalid recover params were accepted: ${JSON.stringify(invalidRecover)}`,
    );
  const snapshot = await secondConnection.request(
    "raw-empty-snapshot",
    "task_graph.snapshot",
    {},
  );
  if (!snapshot.ok)
    throw new Error(`empty snapshot failed: ${JSON.stringify(snapshot)}`);
  secondConnection.close();
}

class RawConnection {
  private readonly decoder = new FrameDecoder();
  private readonly queue: DaemonWireMessage[] = [];
  private readonly waiters: Array<(message: DaemonWireMessage) => void> = [];

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk) => {
      for (const message of this.decoder.push(chunk)) {
        const waiter = this.waiters.shift();
        if (waiter) waiter(message);
        else this.queue.push(message);
      }
    });
  }

  static async open(path: string, id: string): Promise<RawConnection> {
    const socket = await new Promise<Socket>((resolveSocket, reject) => {
      const socket = createConnection(path);
      socket.once("connect", () => resolveSocket(socket));
      socket.once("error", reject);
    });
    const connection = new RawConnection(socket);
    connection.send({
      type: "handshake",
      id,
      version: DAEMON_PROTOCOL_VERSION,
      client: "mindcode-interop-raw",
      capabilities: ["request", "cancel", "task_graph"],
    });
    const handshake = await connection.read();
    if (handshake.type !== "handshake_ack" || !handshake.accepted)
      throw new Error(`raw handshake failed: ${JSON.stringify(handshake)}`);
    return connection;
  }

  request(id: string, method: string, params: unknown): Promise<RawResponse> {
    this.send({ type: "request", id, method, params, stream: false });
    return this.read().then((message) => {
      if (message.type !== "response")
        throw new Error(`raw RPC returned ${message.type}`);
      return message;
    });
  }

  close(): void {
    this.socket.destroy();
  }

  private send(message: DaemonWireMessage): void {
    this.socket.write(encodeFrame(message));
  }

  private read(): Promise<DaemonWireMessage> {
    const message = this.queue.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolveMessage) => this.waiters.push(resolveMessage));
  }
}

type RawResponse = Extract<DaemonWireMessage, { type: "response" }>;

async function waitForSocket(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(path);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`daemon socket was not created: ${path}; ${stderr}`);
}

async function waitForExit(
  processHandle: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<number | null> {
  if (processHandle.exitCode !== null) return processHandle.exitCode;
  return await Promise.race([
    new Promise<number | null>((resolveExit) =>
      processHandle.once("exit", resolveExit),
    ),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("mindcoded did not stop after shutdown");
    }),
  ]);
}
