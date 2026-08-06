import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { withCanonicalWreqLoader } from "./build-bundle.mjs";
import {
  NATIVE_TARGETS,
  currentBunTarget,
  daemonArtifactPath,
  packageManifest,
  resolvePackagedDaemonPath,
  selectBunTargets,
  targetBundleDirectory,
  targetForBun,
  topLevelDaemonPath,
} from "./native-daemon.mjs";

test("maps every supported Bun target to an exact Rust target", () => {
  assert.deepEqual(
    NATIVE_TARGETS.map(({ bunTarget, rustTarget }) => [bunTarget, rustTarget]),
    [
      ["bun-darwin-x64", "x86_64-apple-darwin"],
      ["bun-darwin-arm64", "aarch64-apple-darwin"],
      ["bun-linux-x64", "x86_64-unknown-linux-gnu"],
      ["bun-linux-arm64", "aarch64-unknown-linux-gnu"],
      ["bun-windows-x64", null],
    ],
  );
});

test("detects the host target and rejects unsupported architectures", () => {
  assert.equal(currentBunTarget("darwin", "arm64"), "bun-darwin-arm64");
  assert.equal(currentBunTarget("linux", "x64"), "bun-linux-x64");
  assert.equal(currentBunTarget("win32", "x64"), "bun-windows-x64");
  assert.equal(currentBunTarget("freebsd", "x64"), null);
  assert.throws(
    () => selectBunTargets({ platform: "linux", arch: "ia32", env: {} }),
    /No supported/,
  );
});

test("supports explicit filtering without silently selecting another target", () => {
  const selected = selectBunTargets({
    platform: "darwin",
    arch: "arm64",
    env: { MINDCODE_BUILD_TARGETS: "bun-linux-x64,bun-linux-arm64" },
  });
  assert.deepEqual(
    selected.map(({ bunTarget }) => bunTarget),
    ["bun-linux-x64", "bun-linux-arm64"],
  );
  assert.throws(
    () =>
      selectBunTargets({
        platform: "darwin",
        arch: "arm64",
        env: { MINDCODE_BUILD_TARGETS: "bun-freebsd-x64" },
      }),
    /Unknown MINDCODE_BUILD_TARGETS/,
  );
});

test("preserves explicit target ordering when Windows follows Unix", () => {
  const selected = selectBunTargets({
    platform: "darwin",
    arch: "arm64",
    env: { MINDCODE_BUILD_TARGETS: "bun-linux-x64,bun-windows-x64" },
  });
  assert.deepEqual(
    selected.map(({ bunTarget }) => bunTarget),
    ["bun-linux-x64", "bun-windows-x64"],
  );
});

test("build:daemon rejects all and multi-target selection before invoking Cargo", () => {
  const script = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "build-native-daemon.mjs",
  );
  for (const requestedTargets of ["bun-linux-x64,bun-windows-x64", "all"]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: path.resolve(path.dirname(script), ".."),
      env: {
        ...process.env,
        MINDCODE_BUILD_TARGETS: requestedTargets,
      },
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(
      `${result.stderr}${result.stdout}`,
      /requires exactly one target/,
    );
  }
});

test("keeps daemon artifact paths target-qualified", () => {
  const root = "/repo";
  const target = targetForBun("bun-linux-arm64");
  assert.equal(
    daemonArtifactPath(root, target),
    path.join(
      root,
      "target",
      "aarch64-unknown-linux-gnu",
      "release",
      "mindcoded",
    ),
  );
  assert.equal(
    targetBundleDirectory("/repo/dist", target),
    "/repo/dist/bundles/linux-arm64",
  );
});

test("manifest is resolver-compatible and omits the Windows sidecar", () => {
  const windows = targetForBun("bun-windows-x64");
  const windowsManifest = packageManifest({
    target: windows,
    mindcodePath: "/repo/dist/mindcode.exe",
    daemonPath: null,
    daemonBuilt: false,
  });
  assert.equal(windowsManifest.daemon, null);
  assert.equal(windowsManifest.resolverLayout.daemon, null);
  assert.equal(windowsManifest.resolverLayout.fallback, "typescript");

  const linux = targetForBun("bun-linux-x64");
  const linuxManifest = packageManifest({
    target: linux,
    mindcodePath: "/repo/dist/mindcode-linux-x64",
    daemonPath: "/repo/dist/mindcoded-linux-x64",
    daemonBuilt: true,
  });
  assert.equal(linuxManifest.daemon, "mindcoded-linux-x64");
  assert.deepEqual(linuxManifest.resolverLayout, {
    directory: "bundles/linux-x64",
    executable: "mindcode",
    daemon: "mindcoded",
    fallback: null,
    topLevelExecutable: "mindcode-linux-x64",
    topLevelDaemon: "mindcoded-linux-x64",
  });
});

test("restores the exact wreq loader after an injected target build failure", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mindcode-wreq-"));
  const loaderPath = path.join(directory, "wreq-js.cjs");
  const original = [
    "const nativeRequire = require",
    'nativeRequire("../rust/wreq-js.linux-x64-gnu.node")',
    'require("../rust/wreq-js.darwin-arm64.node")',
  ].join("\n");
  await writeFile(loaderPath, original);

  await assert.rejects(
    withCanonicalWreqLoader({
      loaderPath,
      fileToEmbed: "wreq-js.linux-x64-gnu.node",
      run: async () => {
        const duringBuild = await import("node:fs/promises").then(
          ({ readFile }) => readFile(loaderPath, "utf8"),
        );
        assert.match(
          duringBuild,
          /require\("\.\.\/rust\/wreq-js\.linux-x64-gnu\.node"\)/,
        );
        assert.match(
          duringBuild,
          /nativeRequire\("\.\.\/rust\/wreq-js\.darwin-arm64\.node"\)/,
        );
        throw new Error("injected build failure");
      },
    }),
    /injected build failure/,
  );
  const restored = await import("node:fs/promises").then(({ readFile }) =>
    readFile(loaderPath, "utf8"),
  );
  assert.equal(restored, original);
  await rm(directory, { recursive: true, force: true });
});

test("canonicalizes every target, including Windows, before the build callback", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mindcode-wreq-order-"),
  );
  const loaderPath = path.join(directory, "wreq-js.cjs");
  const original = 'nativeRequire("../rust/wreq-js.win32-x64-msvc.node")\n';
  await writeFile(loaderPath, original);
  const states = [];

  for (const fileToEmbed of ["wreq-js.linux-x64-gnu.node", null]) {
    await withCanonicalWreqLoader({
      loaderPath,
      fileToEmbed,
      run: async () => {
        states.push(
          await import("node:fs/promises").then(({ readFile }) =>
            readFile(loaderPath, "utf8"),
          ),
        );
      },
    });
  }

  assert.match(
    states[0],
    /nativeRequire\("\.\.\/rust\/wreq-js\.win32-x64-msvc\.node"\)/,
  );
  assert.match(
    states[1],
    /nativeRequire\("\.\.\/rust\/wreq-js\.win32-x64-msvc\.node"\)/,
  );
  assert.deepEqual(
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(loaderPath, "utf8"),
    ),
    original,
  );
  await rm(directory, { recursive: true, force: true });
});

test("resolves target-qualified and bundle daemon layouts without compiling", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mindcode-package-"));
  const target = targetForBun("bun-linux-x64");
  const executablePath = path.join(directory, target.mindcodeName);
  const targetDaemon = topLevelDaemonPath(directory, target);
  await writeFile(executablePath, "");
  await writeFile(targetDaemon, "");
  assert.equal(
    resolvePackagedDaemonPath({ outdir: directory, target, executablePath }),
    targetDaemon,
  );

  await rm(targetDaemon);
  const bundleDirectory = targetBundleDirectory(directory, target);
  await mkdir(bundleDirectory, { recursive: true });
  const bundleDaemon = path.join(bundleDirectory, target.daemonExecutableName);
  await writeFile(bundleDaemon, "");
  assert.equal(
    resolvePackagedDaemonPath({ outdir: directory, target, executablePath }),
    bundleDaemon,
  );
  await rm(directory, { recursive: true, force: true });
});
