import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const DAEMON_PACKAGE_SCHEMA = 1;

export const NATIVE_TARGETS = Object.freeze([
  Object.freeze({
    bunTarget: "bun-darwin-x64",
    rustTarget: "x86_64-apple-darwin",
    platform: "darwin",
    arch: "x64",
    suffix: "darwin-x64",
    mindcodeName: "mindcode-darwin-x64",
    daemonName: "mindcoded-darwin-x64",
    daemonExecutableName: "mindcoded",
  }),
  Object.freeze({
    bunTarget: "bun-darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
    platform: "darwin",
    arch: "arm64",
    suffix: "darwin-arm64",
    mindcodeName: "mindcode-darwin-arm64",
    daemonName: "mindcoded-darwin-arm64",
    daemonExecutableName: "mindcoded",
  }),
  Object.freeze({
    bunTarget: "bun-linux-x64",
    rustTarget: "x86_64-unknown-linux-gnu",
    platform: "linux",
    arch: "x64",
    suffix: "linux-x64",
    mindcodeName: "mindcode-linux-x64",
    daemonName: "mindcoded-linux-x64",
    daemonExecutableName: "mindcoded",
  }),
  Object.freeze({
    bunTarget: "bun-linux-arm64",
    rustTarget: "aarch64-unknown-linux-gnu",
    platform: "linux",
    arch: "arm64",
    suffix: "linux-arm64",
    mindcodeName: "mindcode-linux-arm64",
    daemonName: "mindcoded-linux-arm64",
    daemonExecutableName: "mindcoded",
  }),
  Object.freeze({
    bunTarget: "bun-windows-x64",
    rustTarget: null,
    platform: "win32",
    arch: "x64",
    suffix: "windows-x64",
    mindcodeName: "mindcode.exe",
    daemonName: null,
    daemonExecutableName: null,
  }),
]);

export function targetForBun(bunTarget) {
  return (
    NATIVE_TARGETS.find((target) => target.bunTarget === bunTarget) ?? null
  );
}

export function currentBunTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const normalizedArch = arch === "x64" || arch === "arm64" ? arch : null;
  if (!normalizedArch) return null;
  const normalizedPlatform = platform === "win32" ? "windows" : platform;
  return (
    targetForBun(`bun-${normalizedPlatform}-${normalizedArch}`)?.bunTarget ??
    null
  );
}

export function selectBunTargets({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const requested = (env.MINDCODE_BUILD_TARGETS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requested.includes("all")) return [...NATIVE_TARGETS];
  const unknown = requested.filter((value) => !targetForBun(value));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown MINDCODE_BUILD_TARGETS value(s): ${unknown.join(", ")}`,
    );
  }
  const selected = requested.length
    ? requested.map((value) => targetForBun(value)).filter(Boolean)
    : [targetForBun(currentBunTarget(platform, arch))].filter(Boolean);

  if (selected.length === 0) {
    const value = requested.length
      ? requested.join(",")
      : `${platform}/${arch}`;
    throw new Error(`No supported MindCode build target matches ${value}`);
  }

  return selected;
}

export function daemonArtifactPath(root, target) {
  if (!target.rustTarget) return null;
  return path.join(
    root,
    "target",
    target.rustTarget,
    "release",
    target.daemonExecutableName,
  );
}

export function targetBundleDirectory(outdir, target) {
  return path.join(outdir, "bundles", target.suffix);
}

export function topLevelMindcodePath(outdir, target) {
  return path.join(outdir, target.mindcodeName);
}

export function topLevelDaemonPath(outdir, target) {
  return target.daemonName ? path.join(outdir, target.daemonName) : null;
}

export function resolvePackagedDaemonPath({ outdir, target, executablePath }) {
  if (!target.daemonName) return null;
  const executable = executablePath ?? topLevelMindcodePath(outdir, target);
  const targetQualified = path.join(
    path.dirname(executable),
    target.daemonName,
  );
  if (existsSync(targetQualified)) return targetQualified;

  const bundled = path.join(
    targetBundleDirectory(outdir, target),
    target.daemonExecutableName,
  );
  if (existsSync(bundled)) return bundled;

  const legacy = path.join(
    path.dirname(executable),
    target.daemonExecutableName,
  );
  if (existsSync(legacy)) return legacy;
  return targetQualified;
}

export function packageManifest({
  target,
  mindcodePath,
  daemonPath,
  daemonBuilt,
}) {
  return {
    schema: DAEMON_PACKAGE_SCHEMA,
    product: "mindcode",
    bunTarget: target.bunTarget,
    rustTarget: target.rustTarget,
    platform: target.platform,
    arch: target.arch,
    mindcode: path.basename(mindcodePath),
    daemon: daemonBuilt && daemonPath ? path.basename(daemonPath) : null,
    resolverLayout: {
      directory: `bundles/${target.suffix}`,
      executable: target.platform === "win32" ? "mindcode.exe" : "mindcode",
      daemon: target.platform === "win32" ? null : "mindcoded",
      fallback: target.platform === "win32" ? "typescript" : null,
      topLevelExecutable: target.mindcodeName,
      topLevelDaemon: target.daemonName,
    },
  };
}

function runCargoBuild(root, target, cargo = "cargo") {
  if (!target.rustTarget) return null;
  execFileSync(
    cargo,
    [
      "build",
      "--release",
      "--package",
      "mindcoded",
      "--target",
      target.rustTarget,
    ],
    { cwd: root, stdio: "inherit" },
  );
  const artifact = daemonArtifactPath(root, target);
  if (!existsSync(artifact)) {
    throw new Error(`Cargo completed but did not produce ${artifact}`);
  }
  return artifact;
}

export async function packageNativeDaemon({
  root,
  outdir,
  target,
  mindcodePath,
  cargo = "cargo",
}) {
  const daemonArtifact = runCargoBuild(root, target, cargo);
  const bundleDir = targetBundleDirectory(outdir, target);
  await mkdir(bundleDir, { recursive: true });

  const bundledMindcodePath = path.join(
    bundleDir,
    target.platform === "win32" ? "mindcode.exe" : "mindcode",
  );
  await copyFile(mindcodePath, bundledMindcodePath);
  await chmod(bundledMindcodePath, 0o755);

  let daemonPath = null;
  if (daemonArtifact) {
    daemonPath = topLevelDaemonPath(outdir, target);
    await copyFile(daemonArtifact, daemonPath);
    await chmod(daemonPath, 0o755);
    await copyFile(
      daemonArtifact,
      path.join(bundleDir, target.daemonExecutableName),
    );
    await chmod(path.join(bundleDir, target.daemonExecutableName), 0o755);

    if (currentBunTarget() === target.bunTarget) {
      const legacyDaemonPath = path.join(outdir, target.daemonExecutableName);
      await copyFile(daemonArtifact, legacyDaemonPath);
      await chmod(legacyDaemonPath, 0o755);
    }
  }

  const manifest = packageManifest({
    target,
    mindcodePath,
    daemonPath,
    daemonBuilt: Boolean(daemonArtifact),
  });
  const manifestPath = path.join(
    outdir,
    `${target.mindcodeName}.manifest.json`,
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(
    path.join(bundleDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return {
    target,
    daemonArtifact,
    daemonPath,
    bundleDir,
    manifestPath,
    manifest,
  };
}

export async function validateNativePackage({ outdir, target }) {
  const bundleDir = targetBundleDirectory(outdir, target);
  const bundleMindcode = path.join(
    bundleDir,
    target.platform === "win32" ? "mindcode.exe" : "mindcode",
  );
  if (!existsSync(bundleMindcode))
    throw new Error(`Missing bundled MindCode binary: ${bundleMindcode}`);
  const manifestPath = path.join(bundleDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.bunTarget !== target.bunTarget ||
    manifest.rustTarget !== target.rustTarget
  ) {
    throw new Error(`Manifest target mismatch in ${manifestPath}`);
  }
  if (
    manifest.resolverLayout?.topLevelExecutable !== target.mindcodeName ||
    manifest.resolverLayout?.topLevelDaemon !== target.daemonName
  ) {
    throw new Error(`Manifest resolver layout mismatch in ${manifestPath}`);
  }
  if (target.rustTarget) {
    const daemon = path.join(bundleDir, target.daemonExecutableName);
    if (!existsSync(daemon) || (statSync(daemon).mode & 0o111) === 0) {
      throw new Error(`Missing executable daemon for ${target.bunTarget}`);
    }
    const topLevelDaemon = topLevelDaemonPath(outdir, target);
    if (
      !existsSync(topLevelDaemon) ||
      (statSync(topLevelDaemon).mode & 0o111) === 0
    ) {
      throw new Error(
        `Missing target-qualified daemon for ${target.bunTarget}`,
      );
    }
  } else if (manifest.daemon !== null) {
    throw new Error(
      `Windows package must not contain a daemon: ${manifestPath}`,
    );
  }
  return manifest;
}
