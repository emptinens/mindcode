import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../daemon/client.js";
import { CoreToolsDaemonClient } from "./client.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const daemonExecutable = join(repositoryRoot, "target", "debug", "mindcoded");
const interopEnabled = process.env.MINDCODE_NATIVE_INTEROP === "1";
const canRunInterop =
  interopEnabled &&
  process.platform !== "win32" &&
  Bun.file(daemonExecutable).size > 0;

test.skipIf(!canRunInterop)(
  "Rust↔TypeScript core-tools RPC interoperability",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-core-interop-"));
    const socketPath = join(directory, "mindcoded.sock");
    const stateDirectory = join(directory, "state");
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
        "core-tools-ts-interop",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    let client: DaemonClient | undefined;
    let shutdownRequested = false;
    try {
      await waitForSocket(socketPath, child, stderr);
      client = new DaemonClient({ socketPath });
      const daemonStatus = await client.status();
      expect(daemonStatus.build_id).toBe("core-tools-ts-interop");

      const tools = new CoreToolsDaemonClient(client);
      const processResult = await tools.processRun({
        argv: ["/usr/bin/printf", "core-tools-interop"],
        cwd: repositoryRoot,
      });
      expect(processResult.exit_code).toBe(0);
      expect(processResult.stdout).toBe("core-tools-interop");
      expect(processResult.stderr).toBe("");
      expect(processResult.timed_out).toBe(false);
      expect(processResult.truncated).toBe(false);

      const root = await tools.gitRoot({ cwd: repositoryRoot });
      expect(root.root).toBe(repositoryRoot);

      const status = await tools.gitStatus({
        cwd: repositoryRoot,
        include_untracked: true,
      });
      expect(status.root).toBe(repositoryRoot);
      expect(status.detached).toBe(false);
      expect(Array.isArray(status.staged)).toBe(true);
      expect(Array.isArray(status.unstaged)).toBe(true);
      expect(Array.isArray(status.untracked)).toBe(true);
      expect(Array.isArray(status.conflicts)).toBe(true);

      const diff = await tools.gitDiff({
        cwd: repositoryRoot,
        context_lines: 0,
        max_output_bytes: 256 * 1024,
      });
      expect(diff.root).toBe(repositoryRoot);
      expect(typeof diff.patch).toBe("string");
      expect(typeof diff.truncated).toBe("boolean");

      const head = await tools.gitRevParse({
        cwd: repositoryRoot,
        revision: "HEAD",
      });
      expect(head.value).toMatch(/^[0-9a-f]{40}$/);

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
      if (child.exitCode !== null) {
        throw new Error(
          `mindcoded exited before creating its socket (${child.exitCode}): ${stderr}`,
        );
      }
      await Bun.sleep(20);
    }
  }
  throw new Error(`mindcoded socket was not created: ${stderr}`);
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
