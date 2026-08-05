import { strict as assert } from "node:assert";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs, runBenchmark, runOnce, summarize } from "./harness.mjs";

const node = process.execPath;
const fixture = join(import.meta.dirname, "fixture.mjs");

test("parses command without shell interpolation", () => {
  const parsed = parseArgs(["--runs", "3", "--labels", "cold,warm", "--timeout", "100", "--", node, fixture, "ok"]);
  assert.equal(parsed.runs, 3);
  assert.deepEqual(parsed.labels, ["cold", "warm"]);
  assert.deepEqual(parsed.command, [node, fixture, "ok"]);
});

test("records labels, readiness, and percentile summary", async () => {
  const result = await runBenchmark({ runs: 2, labels: ["cold", "warm"], timeoutMs: 2_000, readyRegex: /READY/, command: [node, fixture, "ok"] });
  assert.deepEqual(result.samples.map((sample) => sample.label), ["cold", "warm"]);
  assert.ok(result.samples.every((sample) => sample.ready && sample.exitCode === 0));
  assert.equal(result.summary.count, 2);
  assert.ok(result.summary.minMs <= result.summary.p50Ms);
  assert.ok(result.summary.p50Ms <= result.summary.p95Ms);
});

test("kills a timed out process", async () => {
  const sample = await runOnce(node, [fixture, "hang"], { label: "cold", timeoutMs: 30, readyRegex: undefined });
  assert.equal(sample.timedOut, true);
  assert.notEqual(sample.exitCode, 0);
});

test("reports a missing readiness marker", async () => {
  const sample = await runOnce(node, [fixture, "ok"], { label: "warm", timeoutMs: 2_000, readyRegex: /NEVER/ });
  assert.equal(sample.ready, false);
  assert.equal(sample.exitCode, 0);
});

test("writes JSON output when requested", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindcode-perf-"));
  const output = join(directory, "result.json");
  const { spawnSync } = await import("node:child_process");
  const run = spawnSync(node, [join(import.meta.dirname, "harness.mjs"), "--runs", "1", "--json", output, "--", node, fixture, "ok"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(await readFile(output, "utf8"));
  assert.equal(result.summary.count, 1);
});

test("computes min, p50, p95, and max", () => {
  const summary = summarize([{ durationMs: 1 }, { durationMs: 3 }, { durationMs: 2 }, { durationMs: 10 }]);
  assert.deepEqual(summary, { count: 4, minMs: 1, p50Ms: 2, p95Ms: 10, maxMs: 10 });
});
