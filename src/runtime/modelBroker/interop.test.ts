import { expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../daemon/client.js";
import { ModelCatalogDaemonClient } from "./client.js";
import { createModelCatalogSnapshot } from "./validation.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const daemonExecutable = join(repositoryRoot, "target", "debug", "mindcoded");
const canRunInterop =
  process.env.MINDCODE_NATIVE_INTEROP === "1" &&
  process.platform !== "win32" &&
  Bun.file(daemonExecutable).size > 0;

test.skipIf(!canRunInterop)(
  "Rust↔TypeScript keyless model-catalog cache interoperability",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-model-interop-"));
    const socketPath = join(directory, "mindcoded.sock");
    const child = spawn(
      daemonExecutable,
      [
        "--socket",
        socketPath,
        "--state-dir",
        join(directory, "state"),
        "--idle-seconds",
        "60",
        "--build-id",
        "model-catalog-ts-interop",
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
      await waitForSocket(socketPath, child, () => stderr);
      client = new DaemonClient({ socketPath });
      const cache = new ModelCatalogDaemonClient(client);

      expect(await cache.get()).toBeNull();
      expect(await cache.status()).toEqual({
        state: "empty",
        has_snapshot: false,
      });

      const snapshot = createModelCatalogSnapshot(
        [
          {
            id: "gpt-5.6-luna",
            displayName: "GPT-5.6 Luna",
            available: true,
            status: "available",
            contextLength: 1_100_000,
            supportedReasoningEfforts: [
              "none",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ],
            inputModalities: ["text", "image", "file"],
            outputModalities: ["text"],
            capabilities: { reasoning: true, tools: true, vision: true },
            outputLimit: 128_000,
            outputCreditsPerMillion: 37,
            raw: { must_not_cross_ipc: true },
          },
        ],
        1_000,
      );

      let firstPut: { stored: boolean };
      try {
        firstPut = await cache.put(snapshot);
      } catch (error) {
        const candidate = error as Error & {
          code?: string;
          remoteCode?: string;
        };
        throw new Error(
          `catalog put failed: ${JSON.stringify({
            name: candidate.name,
            code: candidate.code,
            remoteCode: candidate.remoteCode,
            message: candidate.message,
          })}`,
        );
      }
      expect(firstPut).toEqual({ stored: true });
      await expect(cache.put(snapshot)).resolves.toEqual({ stored: false });
      await expect(cache.get()).resolves.toEqual(snapshot);
      await expect(cache.status()).resolves.toEqual({
        state: "ready",
        has_snapshot: true,
        fetched_at_ms: 1_000,
        digest: snapshot.digest,
      });
      expect(JSON.stringify(await cache.get())).not.toContain("raw");
      expect(JSON.stringify(await cache.get())).not.toContain("API_KEY");

      await client.shutdown();
      shutdownRequested = true;
      await waitForExit(child, 3_000);
    } finally {
      client?.close();
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
  stderr: () => string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await access(socketPath);
      return;
    } catch {
      if (child.exitCode !== null) {
        throw new Error(
          `mindcoded exited before creating its socket (${child.exitCode}): ${stderr()}`,
        );
      }
      await Bun.sleep(20);
    }
  }
  throw new Error(`mindcoded socket was not created: ${stderr()}`);
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
