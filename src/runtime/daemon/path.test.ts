import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveDaemonExecutablePath,
  resolveDaemonSocketPath,
} from "./path.js";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "mindcode-daemon-path-"));
  directories.push(directory);
  return directory;
}

describe("daemon executable resolution", () => {
  test("uses the environment override before all layouts", () => {
    expect(
      resolveDaemonExecutablePath(
        { MINDCODE_DAEMON_PATH: "/custom/mindcoded" },
        {
          runtimePath: "/bundle/mindcode",
          platform: "darwin",
          arch: "arm64",
        },
      ),
    ).toBe("/custom/mindcoded");
  });

  test("resolves the bundle sibling first", async () => {
    const directory = await fixture();
    const runtimePath = join(directory, "mindcode");
    const bundleSibling = join(directory, "mindcoded");
    await writeFile(bundleSibling, "bundle");
    await chmod(bundleSibling, 0o755);

    expect(
      resolveDaemonExecutablePath(
        {},
        { runtimePath, platform: "darwin", arch: "arm64" },
      ),
    ).toBe(bundleSibling);
  });

  test("resolves target-qualified top-level sibling when bundle sibling is absent", async () => {
    const directory = await fixture();
    const runtimePath = join(directory, "mindcode-darwin-arm64");
    const qualifiedSibling = join(directory, "mindcoded-darwin-arm64");
    await writeFile(qualifiedSibling, "top-level");
    await chmod(qualifiedSibling, 0o755);

    expect(
      resolveDaemonExecutablePath(
        {},
        { runtimePath, platform: "darwin", arch: "arm64" },
      ),
    ).toBe(qualifiedSibling);
  });

  test("normalizes Rust architecture names and keeps the fallback deterministic", async () => {
    const directory = await fixture();
    const runtimePath = join(directory, "mindcode-linux-x64");
    expect(
      resolveDaemonExecutablePath(
        {},
        { runtimePath, platform: "linux", arch: "x86_64" },
      ),
    ).toBe(join(directory, "mindcoded"));
  });

  test("expands the configured home socket path", () => {
    expect(
      resolveDaemonSocketPath({ MINDCODE_DAEMON_SOCKET: "~/run.sock" }),
    ).toContain("/run.sock");
  });
});
