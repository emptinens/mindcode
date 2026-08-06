import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AdaptiveStdioTransport } from "../../services/mcp/AdaptiveStdioTransport.js";
import { RustStdioTransport } from "../../services/mcp/RustStdioTransport.js";
import { DaemonClient } from "../daemon/client.js";
import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { DaemonMcpStdioRpc } from "./client.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const daemonExecutable = join(repositoryRoot, "target", "debug", "mindcoded");
const interopEnabled = process.env.MINDCODE_NATIVE_INTEROP === "1";
const canRunInterop =
  interopEnabled &&
  process.platform !== "win32" &&
  Bun.file(daemonExecutable).size > 0;

test.skipIf(!canRunInterop)(
  "Rust↔TypeScript MCP stdio RPC interoperability",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-mcp-interop-"));
    const socketPath = join(directory, "mindcoded.sock");
    const stateDirectory = join(directory, "state");
    const echoScript = join(directory, "echo-json-rpc.sh");
    await writeFile(
      echoScript,
      "#!/bin/sh\nwhile IFS= read -r line; do\n  printf '%s\\n' \"$line\"\ndone\n",
      { mode: 0o700 },
    );
    await chmod(echoScript, 0o700);

    const child = spawn(
      daemonExecutable,
      [
        "--socket",
        socketPath,
        "--state-dir",
        stateDirectory,
        "--idle-seconds",
        "60",
        "--build-id",
        "mcp-ts-interop",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let client: DaemonClient | undefined;
    let shutdownRequested = false;
    const connectionId = "mcp-interop";
    try {
      await waitForSocket(socketPath, child, stderr);
      client = new DaemonClient({ socketPath });
      const rpc = new DaemonMcpStdioRpc(client);
      const opened = await rpc.open({
        connection_id: connectionId,
        command: echoScript,
        args: [],
        cwd: directory,
      });
      expect(opened.connection_id).toBe(connectionId);
      expect(opened.pid).toBeGreaterThan(0);

      const running = await rpc.status({ connection_id: connectionId });
      expect(running.connections).toHaveLength(1);
      expect(running.connections[0]?.connection_id).toBe(connectionId);
      expect(running.connections[0]?.state).toBe("running");

      const message = {
        jsonrpc: "2.0" as const,
        id: "echo-1",
        method: "echo",
        params: { value: "mcp-interop" },
      };
      await expect(
        rpc.send({ connection_id: connectionId, message }),
      ).resolves.toEqual({
        accepted: true,
      });
      await expect(
        rpc.receive({ connection_id: connectionId, timeout_ms: 3_000 }),
      ).resolves.toEqual({ message, closed: false });

      const afterReceive = await rpc.status({});
      expect(afterReceive.connections).toHaveLength(1);
      expect(afterReceive.connections[0]?.queued_messages).toBe(0);

      await expect(rpc.close({ connection_id: connectionId })).resolves.toEqual(
        {
          closed: true,
        },
      );
      await expect(rpc.status({})).resolves.toEqual({ connections: [] });

      await client.shutdown();
      shutdownRequested = true;
      await waitForExit(child, 3_000);
    } finally {
      if (client) client.close();
      if (!shutdownRequested && child.exitCode === null) child.kill("SIGKILL");
      await waitForExit(child, 3_000).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }

    expect(stderr).not.toContain("panicked");
  },
);

test.skipIf(!canRunInterop)(
  "MCP SDK Client uses the Rust daemon authority for a real stdio server",
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "mindcode-mcp-sdk-interop-"),
    );
    const socketPath = join(directory, "mindcoded.sock");
    const stateDirectory = join(directory, "state");
    const serverScript = join(directory, "mcp-server.mjs");
    const markerPath = join(directory, "server-events.log");
    await writeFile(
      serverScript,
      `import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const markerPath = process.argv[2];
const record = (event) => appendFileSync(markerPath, event + "\\n");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

input.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.method === "initialize" && message.id !== undefined) {
    record("initialize");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "mindcode-interop-server", version: "0.1.0" },
      },
    });
    return;
  }

  if (message.method === "notifications/initialized") {
    record("initialized");
    return;
  }

  if (message.method === "tools/list" && message.id !== undefined) {
    record("tools-list");
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [] } });
    return;
  }

  if (message.method === "ping" && message.id !== undefined) {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }

  if (message.id !== undefined) {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
  }
});
`,
      { mode: 0o700 },
    );
    await chmod(serverScript, 0o700);

    const child = spawn(
      daemonExecutable,
      [
        "--socket",
        socketPath,
        "--state-dir",
        stateDirectory,
        "--idle-seconds",
        "60",
        "--build-id",
        "mcp-sdk-interop",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const daemonClient = new DaemonClient({ socketPath });
    const rpcManager = {
      requestWithFallback: async <T>(
        method: string,
        params: unknown,
        fallback: T | (() => T | Promise<T>),
        options: DaemonRequestOptions = {},
      ): Promise<DaemonCallResult<T>> => {
        try {
          return {
            source: "daemon",
            value: await daemonClient.request<T>(method, params, options),
          };
        } catch (error) {
          return {
            source: "fallback",
            value:
              typeof fallback === "function"
                ? await (fallback as () => T | Promise<T>)()
                : fallback,
            reason: "unavailable",
            error,
          };
        }
      },
    };
    const rpc = new DaemonMcpStdioRpc(rpcManager);
    const server = {
      command: process.execPath,
      args: [serverScript, markerPath],
      cwd: directory,
    };
    const transport = new AdaptiveStdioTransport(server, {
      daemonReady: () => daemonClient.connect(),
      rustFactory: (parameters) =>
        new RustStdioTransport(parameters, {
          rpc,
          beforeOpen: () => daemonClient.connect(),
        }),
    });
    const client = new Client(
      { name: "mindcode-interop-client", version: "0.1.0" },
      { capabilities: {} },
    );
    let shutdownRequested = false;

    try {
      await waitForSocket(socketPath, child, stderr);
      await client.connect(transport);

      expect(transport.authority).toBe("rust");
      expect(transport.pid).toBeGreaterThan(0);
      const tools = await client.request(
        { method: "tools/list", params: {} },
        ListToolsResultSchema,
      );
      expect(tools).toEqual({ tools: [] });
      await expect(
        waitForFileEvents(markerPath, [
          "initialize",
          "initialized",
          "tools-list",
        ]),
      ).resolves.toContain("tools-list");

      await expect(client.close()).resolves.toBeUndefined();
      await expect(rpc.status({})).resolves.toEqual({ connections: [] });
      await expect(transport.close()).resolves.toBeUndefined();

      await daemonClient.shutdown();
      shutdownRequested = true;
      await waitForExit(child, 3_000);
    } finally {
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      daemonClient.close();
      if (!shutdownRequested && child.exitCode === null) child.kill("SIGKILL");
      await waitForExit(child, 3_000).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }

    expect(stderr).not.toContain("panicked");
  },
);

async function waitForSocket(
  socketPath: string,
  child: ChildProcess,
  stderr: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      // The daemon may still be creating its runtime directory.
    }
    if (child.exitCode !== null) {
      throw new Error(
        `mindcoded exited before creating its socket (${child.exitCode}): ${stderr}`,
      );
    }
    await Bun.sleep(20);
  }
  throw new Error(`mindcoded socket was not created: ${stderr}`);
}

async function waitForFileEvents(
  path: string,
  expected: readonly string[],
): Promise<string> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      const contents = await readFile(path, "utf8");
      if (expected.every((event) => contents.split("\n").includes(event))) {
        return contents;
      }
    } catch {
      // The stdio server may not have received initialize yet.
    }
    await Bun.sleep(20);
  }
  throw new Error(`MCP server did not receive events: ${expected.join(", ")}`);
}

async function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return Promise.race([
    new Promise<number | null>((resolveExit) =>
      child.once("exit", (code) => resolveExit(code)),
    ),
    Bun.sleep(timeoutMs).then(() => {
      throw new Error("mindcoded did not exit after shutdown");
    }),
  ]);
}
