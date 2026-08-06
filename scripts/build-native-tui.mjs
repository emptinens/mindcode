#!/usr/bin/env node
import path from "node:path";
import { packageNativeTui, selectNativeTuiTargets } from "./native-tui.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.join(root, "dist");
const targets = selectNativeTuiTargets();

for (const target of targets) {
  const result = await packageNativeTui({ root, outdir, target });
  console.log(`Packaged ${result.topLevelPath}`);
}
