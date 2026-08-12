import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  evaluateReleasePerformance,
  releaseArtifactManifest,
} from "./release-gates.mjs";

test("requires a 20 percent improvement for every measured metric", () => {
  const passed = evaluateReleasePerformance(
    { latency: 80, memory: 800 },
    { latency: 100, memory: 1_000 },
  );
  assert.equal(passed.passed, true);
  const failed = evaluateReleasePerformance(
    { latency: 81, memory: 800 },
    { latency: 100, memory: 1_000 },
  );
  assert.equal(failed.passed, false);
  assert.equal(failed.metrics.latency.improved, false);
});

test("validates the Linux x64 artifact manifest and executable sizes", () => {
  const result = releaseArtifactManifest(
    new URL("../../dist/", import.meta.url).pathname,
  );
  assert.equal(result.target, "bun-linux-x64");
  assert.ok(result.files.mindcode > 0);
  assert.equal(Object.keys(result.checksums).length, 3);
});
