import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const NATIVE_TUI_PACKAGE_SCHEMA = 1;
export const NATIVE_TUI_CRATE_MANIFEST = "crates/mindcode-tui/Cargo.toml";
export const NATIVE_TUI_BUNDLE_MANIFEST = "mindcode-tui.manifest.json";

export const NATIVE_TUI_TARGETS = Object.freeze([
  Object.freeze({
    bunTarget: "bun-darwin-x64",
    rustTarget: "x86_64-apple-darwin",
    platform: "darwin",
    arch: "x64",
    suffix: "darwin-x64",
    tuiName: "mindcode-tui-darwin-x64",
    tuiExecutableName: "mindcode-tui",
  }),
  Object.freeze({
    bunTarget: "bun-darwin-arm64",
    rustTarget: "aarch64-apple-darwin",
    platform: "darwin",
    arch: "arm64",
    suffix: "darwin-arm64",
    tuiName: "mindcode-tui-darwin-arm64",
    tuiExecutableName: "mindcode-tui",
  }),
  Object.freeze({
    bunTarget: "bun-linux-x64",
    rustTarget: "x86_64-unknown-linux-gnu",
    platform: "linux",
    arch: "x64",
    suffix: "linux-x64",
    tuiName: "mindcode-tui-linux-x64",
    tuiExecutableName: "mindcode-tui",
  }),
  Object.freeze({
    bunTarget: "bun-linux-arm64",
    rustTarget: "aarch64-unknown-linux-gnu",
    platform: "linux",
    arch: "arm64",
    suffix: "linux-arm64",
    tuiName: "mindcode-tui-linux-arm64",
    tuiExecutableName: "mindcode-tui",
  }),
]);

export const TUI_TARGETS = NATIVE_TUI_TARGETS;

export function targetForBun(bunTarget) {
  return (
    NATIVE_TUI_TARGETS.find((target) => target.bunTarget === bunTarget) ?? null
  );
}

export const nativeTuiTargetForBun = targetForBun;

export function currentNativeTuiTarget(
  platform = process.platform,
  arch = process.arch,
) {
  const normalizedPlatform = platform === "win32" ? "windows" : platform;
  if (normalizedPlatform !== "darwin" && normalizedPlatform !== "linux") {
    return null;
  }
  if (arch !== "x64" && arch !== "arm64") return null;
  return targetForBun(`bun-${normalizedPlatform}-${arch}`);
}

export function currentNativeTuiBunTarget(
  platform = process.platform,
  arch = process.arch,
) {
  return currentNativeTuiTarget(platform, arch)?.bunTarget ?? null;
}

export const currentTuiTarget = currentNativeTuiTarget;

export function selectNativeTuiTargets({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const requestedValue =
    env.MINDCODE_TUI_BUILD_TARGETS ?? env.MINDCODE_BUILD_TARGETS ?? "";
  const requested = requestedValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (requested.includes("all")) return [...NATIVE_TUI_TARGETS];

  const unknown = requested.filter((value) => !targetForBun(value));
  const windows = requested.filter((value) => value.includes("windows"));
  if (windows.length > 0) {
    throw new Error(
      `Windows native TUI targets are unsupported: ${windows.join(", ")}`,
    );
  }
  if (unknown.length > 0) {
    throw new Error(
      `Unknown MINDCODE_TUI_BUILD_TARGETS value(s): ${unknown.join(", ")}`,
    );
  }

  const selected = requested.length
    ? requested.map((value) => targetForBun(value)).filter(Boolean)
    : [currentNativeTuiTarget(platform, arch)].filter(Boolean);
  if (selected.length === 0) {
    const value = requested.length
      ? requested.join(",")
      : `${platform}/${arch}`;
    throw new Error(`No supported native TUI target matches ${value}`);
  }
  return selected;
}

export function tuiArtifactPath(root, target) {
  return path.join(
    root,
    "crates",
    "mindcode-tui",
    "target",
    target.rustTarget,
    "release",
    target.tuiExecutableName,
  );
}

export function targetBundleDirectory(outdir, target) {
  return path.join(outdir, "bundles", target.suffix);
}

export function topLevelTuiPath(outdir, target) {
  return path.join(outdir, target.tuiName);
}

export function packagedTuiPath({ outdir, target, executablePath } = {}) {
  const executable = executablePath ?? topLevelTuiPath(outdir, target);
  const targetQualified = path.join(path.dirname(executable), target.tuiName);
  if (existsSync(targetQualified)) return targetQualified;

  const bundled = path.join(
    targetBundleDirectory(outdir, target),
    target.tuiExecutableName,
  );
  if (existsSync(bundled)) return bundled;
  return targetQualified;
}

export const resolvePackagedTuiPath = packagedTuiPath;

export function packageManifest({ target, tuiPath }) {
  return {
    schema: NATIVE_TUI_PACKAGE_SCHEMA,
    product: "mindcode",
    bunTarget: target.bunTarget,
    rustTarget: target.rustTarget,
    platform: target.platform,
    arch: target.arch,
    tui: path.basename(tuiPath),
    resolverLayout: {
      directory: `bundles/${target.suffix}`,
      executable: target.tuiExecutableName,
      topLevelExecutable: target.tuiName,
    },
  };
}

function runCargoBuild(root, target, cargo = "cargo") {
  execFileSync(
    cargo,
    [
      "build",
      "--release",
      "--manifest-path",
      path.join(root, NATIVE_TUI_CRATE_MANIFEST),
      "--target",
      target.rustTarget,
      "--locked",
    ],
    { cwd: root, stdio: "inherit" },
  );
  const artifact = tuiArtifactPath(root, target);
  if (!existsSync(artifact)) {
    throw new Error(`Cargo completed but did not produce ${artifact}`);
  }
  return artifact;
}

export async function packageNativeTui({
  root,
  outdir,
  target,
  artifactPath,
  cargo = "cargo",
}) {
  if (!targetForBun(target.bunTarget)) {
    throw new Error(`Unsupported native TUI target: ${target.bunTarget}`);
  }
  const artifact = artifactPath ?? runCargoBuild(root, target, cargo);
  if (!existsSync(artifact))
    throw new Error(`Missing TUI artifact: ${artifact}`);

  const bundleDir = targetBundleDirectory(outdir, target);
  await mkdir(bundleDir, { recursive: true });
  const topLevelPath = topLevelTuiPath(outdir, target);
  const bundledPath = path.join(bundleDir, target.tuiExecutableName);
  await copyFile(artifact, topLevelPath);
  await copyFile(artifact, bundledPath);
  await chmod(topLevelPath, 0o755);
  await chmod(bundledPath, 0o755);

  const manifest = packageManifest({ target, tuiPath: topLevelPath });
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = path.join(outdir, `${target.tuiName}.manifest.json`);
  await writeFile(manifestPath, manifestBytes);
  await writeFile(
    path.join(bundleDir, NATIVE_TUI_BUNDLE_MANIFEST),
    manifestBytes,
  );
  return {
    target,
    artifact,
    topLevelPath,
    bundledPath,
    bundleDir,
    manifestPath,
    manifest,
  };
}

export async function validateNativeTuiPackage({ outdir, target }) {
  const bundleDir = targetBundleDirectory(outdir, target);
  const bundledPath = path.join(bundleDir, target.tuiExecutableName);
  const topLevelPath = topLevelTuiPath(outdir, target);
  if (!existsSync(bundledPath) || (statSync(bundledPath).mode & 0o111) === 0) {
    throw new Error(`Missing executable TUI bundle: ${bundledPath}`);
  }
  if (
    !existsSync(topLevelPath) ||
    (statSync(topLevelPath).mode & 0o111) === 0
  ) {
    throw new Error(`Missing target-qualified TUI binary: ${topLevelPath}`);
  }
  const manifestPath = path.join(bundleDir, NATIVE_TUI_BUNDLE_MANIFEST);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const expected = packageManifest({ target, tuiPath: topLevelPath });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error(`Manifest metadata mismatch in ${manifestPath}`);
  }
  const topLevelManifestPath = path.join(
    outdir,
    `${target.tuiName}.manifest.json`,
  );
  const topLevelManifest = JSON.parse(
    await readFile(topLevelManifestPath, "utf8"),
  );
  if (JSON.stringify(topLevelManifest) !== JSON.stringify(expected)) {
    throw new Error(`Manifest metadata mismatch in ${topLevelManifestPath}`);
  }
  return manifest;
}
