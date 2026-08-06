import { strict as assert } from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  NATIVE_TUI_BUNDLE_MANIFEST,
  NATIVE_TUI_TARGETS,
  currentNativeTuiTarget,
  packageManifest,
  packageNativeTui,
  packagedTuiPath,
  selectNativeTuiTargets,
  targetBundleDirectory,
  targetForBun,
  topLevelTuiPath,
  tuiArtifactPath,
  validateNativeTuiPackage,
} from "./native-tui.mjs";

test("supports only macOS/Linux x64 and arm64 native TUI targets", () => {
  assert.deepEqual(
    NATIVE_TUI_TARGETS.map(({ bunTarget, rustTarget }) => [
      bunTarget,
      rustTarget,
    ]),
    [
      ["bun-darwin-x64", "x86_64-apple-darwin"],
      ["bun-darwin-arm64", "aarch64-apple-darwin"],
      ["bun-linux-x64", "x86_64-unknown-linux-gnu"],
      ["bun-linux-arm64", "aarch64-unknown-linux-gnu"],
    ],
  );
  assert.equal(currentNativeTuiTarget("win32", "x64"), null);
  assert.throws(
    () => selectNativeTuiTargets({ platform: "win32", arch: "x64", env: {} }),
    /No supported native TUI target/,
  );
});

test("selects all targets and rejects Windows without fallback", () => {
  assert.deepEqual(
    selectNativeTuiTargets({ env: { MINDCODE_TUI_BUILD_TARGETS: "all" } }).map(
      ({ bunTarget }) => bunTarget,
    ),
    NATIVE_TUI_TARGETS.map(({ bunTarget }) => bunTarget),
  );
  assert.throws(
    () =>
      selectNativeTuiTargets({
        env: { MINDCODE_TUI_BUILD_TARGETS: "bun-windows-x64" },
      }),
    /Windows native TUI targets are unsupported/,
  );
});

test("uses deterministic target-qualified and bundle manifests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mindcode-tui-package-"));
  const outdir = path.join(root, "dist");
  const artifact = path.join(root, "mindcode-tui-artifact");
  await writeFile(artifact, "fixture-native-tui");
  const target = targetForBun("bun-linux-x64");
  const bundleDir = targetBundleDirectory(outdir, target);
  await mkdir(bundleDir, { recursive: true });
  const daemonManifest = JSON.stringify({ product: "mindcode", daemon: true });
  await writeFile(path.join(bundleDir, "manifest.json"), daemonManifest);
  const result = await packageNativeTui({
    root,
    outdir,
    target,
    artifactPath: artifact,
  });
  const secondManifest = packageManifest({
    target,
    tuiPath: result.topLevelPath,
  });
  assert.deepEqual(result.manifest, secondManifest);
  assert.equal(
    await readFile(path.join(result.bundleDir, "manifest.json"), "utf8"),
    daemonManifest,
  );
  assert.equal(
    await readFile(
      path.join(result.bundleDir, NATIVE_TUI_BUNDLE_MANIFEST),
      "utf8",
    ),
    `${JSON.stringify(secondManifest, null, 2)}\n`,
  );
  assert.equal(
    packagedTuiPath({ outdir, target }),
    topLevelTuiPath(outdir, target),
  );
  assert.equal(
    targetBundleDirectory(outdir, target),
    path.join(outdir, "bundles", "linux-x64"),
  );
  assert.equal(
    tuiArtifactPath(root, target),
    path.join(
      root,
      "crates/mindcode-tui/target/x86_64-unknown-linux-gnu/release/mindcode-tui",
    ),
  );
  assert.deepEqual(
    await validateNativeTuiPackage({ outdir, target }),
    result.manifest,
  );
});

test("resolves a bundle when the target-qualified copy is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mindcode-tui-resolve-"));
  const outdir = path.join(root, "dist");
  const target = targetForBun("bun-darwin-arm64");
  const artifact = path.join(root, "artifact");
  await writeFile(artifact, "fixture");
  const result = await packageNativeTui({
    root,
    outdir,
    target,
    artifactPath: artifact,
  });
  const qualified = topLevelTuiPath(outdir, target);
  const { unlink } = await import("node:fs/promises");
  await unlink(qualified);
  assert.equal(packagedTuiPath({ outdir, target }), result.bundledPath);
  await chmod(result.bundledPath, 0o755);
});

if (process.env.MINDCODE_TUI_VALIDATE === "1") {
  test("validates the built native TUI package for the selected target", async () => {
    const root = path.resolve(import.meta.dirname, "..");
    const outdir = path.join(root, "dist");
    const targets = selectNativeTuiTargets({ env: process.env });
    for (const target of targets) {
      await validateNativeTuiPackage({ outdir, target });
    }
  });
}
