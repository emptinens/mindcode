import { spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../src/runtime/daemon/client.js";

const root = resolve(import.meta.dirname, "..");
const executable =
  process.env.MINDCODE_DAEMON_PATH ??
  join(root, "target", "debug", "mindcoded");
const directory = await mkdtemp(join(tmpdir(), "mindcoded-interop-"));
const socketPath = join(directory, "mindcoded-v1.sock");
let stderr = "";
const child = spawn(
  executable,
  ["--socket", socketPath, "--idle-seconds", "60", "--build-id", "ts-interop"],
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
  await client.shutdown();
  const exitCode = await waitForExit(child, 3_000);
  if (exitCode !== 0)
    throw new Error(`mindcoded exited ${exitCode}: ${stderr}`);
  process.stdout.write("Rust/TypeScript daemon interoperability: PASS\n");
} finally {
  if (child.exitCode === null) child.kill("SIGKILL");
  await rm(directory, { recursive: true, force: true });
}

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
