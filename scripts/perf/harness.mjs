#!/usr/bin/env node
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 30_000;

function usage() {
  return `Usage: node scripts/perf/harness.mjs [options] -- command [args...]

Options:
  --runs N                 Number of executions (default: 1)
  --label NAME             Label for every run; repeat to label runs in order
  --labels a,b             Comma-separated labels, one per run (default: warm)
  --timeout MS             Per-run timeout (default: 30000)
  --ready-regex REGEX      Wait for this stdout marker before accepting readiness
  --json [PATH]            Emit JSON to stdout, or write it to PATH
  --help                   Show this help
`;
}

export function parseArgs(argv) {
  const options = {
    runs: 1,
    labels: [],
    timeoutMs: DEFAULT_TIMEOUT_MS,
    readyRegex: undefined,
    jsonPath: undefined,
  };
  let command;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      i += 1;
      return argv[i];
    };
    if (arg === "--") {
      command = argv.slice(i + 1);
      break;
    }
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--runs") options.runs = positiveInteger(next(), "runs");
    else if (arg === "--label") options.labels.push(next());
    else if (arg === "--labels") options.labels.push(...next().split(",").filter(Boolean));
    else if (arg === "--timeout") options.timeoutMs = positiveInteger(next(), "timeout");
    else if (arg === "--ready-regex") options.readyRegex = new RegExp(next());
    else if (arg === "--json") {
      const candidate = argv[i + 1];
      if (candidate && !candidate.startsWith("--") && candidate !== "--") options.jsonPath = next();
      else options.jsonPath = "-";
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!command?.length) throw new Error("A command is required after --");
  if (!options.labels.length) options.labels = ["warm"];
  return { ...options, command };
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === "win32") child.kill("SIGKILL");
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }
}

export function runOnce(command, args, { label, timeoutMs, readyRegex }) {
  return new Promise((resolve) => {
    const startedAt = performance.now();
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let ready = !readyRegex;
    let timedOut = false;
    let readyMatchedAt;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (!ready && readyRegex.test(stdout)) {
        ready = true;
        readyMatchedAt = performance.now();
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ label, durationMs: performance.now() - startedAt, exitCode: null, signal: null, timedOut, ready, readyMatchedAt, stdout, stderr, error: error.message });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ label, durationMs: performance.now() - startedAt, exitCode, signal, timedOut, ready, readyMatchedAt, stdout, stderr });
    });
  });
}

export function summarize(samples) {
  const durations = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (p) => durations[Math.min(durations.length - 1, Math.ceil((p / 100) * durations.length) - 1)];
  return { count: durations.length, minMs: durations[0], p50Ms: percentile(50), p95Ms: percentile(95), maxMs: durations.at(-1) };
}

export async function runBenchmark(options) {
  const samples = [];
  for (let index = 0; index < options.runs; index += 1) {
    samples.push(await runOnce(options.command[0], options.command.slice(1), {
      label: options.labels[index] ?? options.labels.at(-1),
      timeoutMs: options.timeoutMs,
      readyRegex: options.readyRegex,
    }));
  }
  return { version: 1, command: options.command, runs: options.runs, timeoutMs: options.timeoutMs, readinessRegex: options.readyRegex?.source ?? null, samples, summary: summarize(samples) };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage()); process.exit(0); }
    const result = await runBenchmark(options);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.jsonPath && options.jsonPath !== "-") {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(options.jsonPath, json, "utf8");
    } else process.stdout.write(json);
    if (result.samples.some((sample) => sample.timedOut || sample.exitCode !== 0 || !sample.ready)) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`);
    process.exitCode = 2;
  }
}
