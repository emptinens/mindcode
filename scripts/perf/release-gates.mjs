#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

export const LINUX_X64_RELEASE_TARGET = "bun-linux-x64";
export const RELEASE_PERFORMANCE_SCHEMA = 1;
export const RELEASE_PERFORMANCE_IMPROVEMENT = 0.2;

export function summarizeBytes(value) {
  if (!value || typeof value !== "object")
    throw new TypeError("bytes must be an object");
  const result = {};
  for (const [name, bytes] of Object.entries(value)) {
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw new TypeError(`${name} bytes must be non-negative`);
    result[name] = bytes;
  }
  return result;
}

export function evaluateReleasePerformance(
  current,
  baseline,
  improvement = RELEASE_PERFORMANCE_IMPROVEMENT,
) {
  if (!Number.isFinite(improvement) || improvement < 0 || improvement >= 1)
    throw new TypeError("improvement must be in [0, 1)");
  const metrics = Object.fromEntries(
    Object.keys(baseline).map((name) => {
      const before = baseline[name];
      const after = current[name];
      if (
        !Number.isFinite(before) ||
        before <= 0 ||
        !Number.isFinite(after) ||
        after < 0
      )
        throw new TypeError(`${name} must be finite and positive in baseline`);
      const target = before * (1 - improvement);
      return [
        name,
        { baseline: before, current: after, target, improved: after <= target },
      ];
    }),
  );
  return {
    schema: RELEASE_PERFORMANCE_SCHEMA,
    improvement,
    metrics,
    passed: Object.values(metrics).every((metric) => metric.improved),
  };
}

export function releaseArtifactManifest(outdir) {
  const bundleDir = path.join(outdir, "bundles", "linux-x64");
  const files = ["mindcode", "mindcoded", "mindcode-tui"].map((name) =>
    path.join(bundleDir, name),
  );
  for (const file of files) {
    if (!existsSync(file) || (statSync(file).mode & 0o111) === 0)
      throw new Error(`Missing executable Linux x64 artifact: ${file}`);
  }
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!existsSync(manifestPath))
    throw new Error(`Missing Linux x64 manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest.bunTarget !== LINUX_X64_RELEASE_TARGET ||
    manifest.platform !== "linux" ||
    manifest.arch !== "x64"
  )
    throw new Error("Linux x64 manifest identity mismatch");
  const checksums = Object.fromEntries(
    files.map((file) => [
      path.basename(file),
      createHash("sha256").update(readFileSync(file)).digest("hex"),
    ]),
  );
  return {
    schema: RELEASE_PERFORMANCE_SCHEMA,
    target: LINUX_X64_RELEASE_TARGET,
    manifest,
    files: summarizeBytes(
      Object.fromEntries(
        files.map((file) => [path.basename(file), statSync(file).size]),
      ),
    ),
    checksums,
  };
}

export function packageDirectoryMetadata(outdir) {
  const directory = path.join(outdir, "bundles", "linux-x64");
  const result = releaseArtifactManifest(outdir);
  const files = Object.keys(result.files);
  return { directory, files, manifest: result.manifest, checksums: result.checksums, bytes: Object.values(result.files).reduce((sum, value) => sum + value, 0) };
}
