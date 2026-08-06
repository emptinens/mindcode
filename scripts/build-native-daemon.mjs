#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  currentBunTarget,
  daemonArtifactPath,
  selectBunTargets,
} from "./native-daemon.mjs";

const root = path.resolve(import.meta.dirname, "..");
const targets = selectBunTargets();
if (targets.length !== 1) {
  throw new Error(
    `build:daemon requires exactly one target; received ${targets.map(({ bunTarget }) => bunTarget).join(", ") || "none"}. Set MINDCODE_BUILD_TARGETS to one exact bun target.`,
  );
}
const target = targets[0];

if (!target.rustTarget) {
  console.log(
    `No native mindcoded sidecar for ${target.bunTarget}; TypeScript fallback is used.`,
  );
  process.exit(0);
}

execFileSync(
  "cargo",
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
console.log(
  `Built ${daemonArtifactPath(root, target)} for ${currentBunTarget() === target.bunTarget ? "host" : target.bunTarget}`,
);
