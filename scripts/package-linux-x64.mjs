#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { releaseArtifactManifest } from "./perf/release-gates.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist");
const bundleDir = path.join(outdir, "bundles", "linux-x64");
const releaseDir = path.join(outdir, "release", "linux-x64");
const archivePath = path.join(outdir, "mindcode-0.1.2-linux-x64.tar.gz");
const artifact = releaseArtifactManifest(outdir);
const files = Object.keys(artifact.files);
const checksums = `${files
  .map((name) => `${artifact.checksums[name]}  ${name}`)
  .join("\n")}\n`;

await mkdir(releaseDir, { recursive: true, mode: 0o755 });
const manifest = {
  schema: 1,
  product: "mindcode",
  version: "0.1.2",
  target: "linux-x64",
  executables: files,
  checksums: artifact.checksums,
};
await writeFile(
  path.join(releaseDir, "manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
await writeFile(path.join(releaseDir, "SHA256SUMS"), checksums, "utf8");
for (const name of files) {
  const releasePath = path.join(releaseDir, name);
  await writeFile(releasePath, await readFile(path.join(bundleDir, name)));
  await chmod(releasePath, 0o755);
}
await writeFile(
  path.join(releaseDir, "README.txt"),
  "MindCode 0.1.2 Linux x64\n\nRun ./mindcode --help.\nVerify files with sha256sum -c SHA256SUMS.\nNo JDK or external Node runtime is required.\n",
  "utf8",
);
execFileSync("tar", ["-czf", archivePath, "-C", outdir, "release/linux-x64"], {
  cwd: root,
  stdio: "inherit",
});
const archiveBytes = await readFile(archivePath);
const archiveChecksum = createHash("sha256").update(archiveBytes).digest("hex");
await writeFile(
  `${archivePath}.sha256`,
  `${archiveChecksum}  ${path.basename(archivePath)}\n`,
  "utf8",
);
const archiveStat = await stat(archivePath);
console.log(
  JSON.stringify(
    { archivePath, archiveBytes: archiveStat.size, manifest },
    null,
    2,
  ),
);
