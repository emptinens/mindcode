#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { decode, encode } from "@msgpack/msgpack";
import {
  currentNativeTuiTarget,
  topLevelTuiPath,
  tuiArtifactPath,
} from "../native-tui.mjs";

export const NATIVE_TUI_PERF_SCHEMA = 1;
export const DEFAULT_NATIVE_TUI_FIXTURE = path.resolve(
  import.meta.dirname,
  "../../tests/fixtures/native-tui-perf.json",
);
export const NATIVE_TUI_GATES = Object.freeze({
  inputReadyMs: 500,
  coldDispatchMs: 100,
  warmDispatchMs: 50,
});
export const NATIVE_TUI_PERFORMANCE_GATES = NATIVE_TUI_GATES;

const METRICS = Object.freeze(Object.keys(NATIVE_TUI_GATES));

export function percentile(values, percentileValue) {
  if (!values.length)
    throw new Error("At least one performance sample is required");
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentileValue / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

export function summarizeSamples(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("Performance samples must be a non-empty array");
  }
  if (
    values.some(
      (value) =>
        typeof value !== "number" || !Number.isFinite(value) || value < 0,
    )
  ) {
    throw new Error(
      "Performance samples must contain finite non-negative numbers",
    );
  }
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    minMs: sorted[0],
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    maxMs: sorted.at(-1),
  };
}

export function normalizeSamples(value) {
  const samples = value?.samples ?? value;
  if (!samples || typeof samples !== "object" || Array.isArray(samples)) {
    throw new Error("Native TUI samples must be an object");
  }
  return Object.fromEntries(
    METRICS.map((metric) => {
      const aliases = {
        inputReadyMs: ["inputReadyMs", "inputReady"],
        coldDispatchMs: ["coldDispatchMs", "coldDispatch"],
        warmDispatchMs: ["warmDispatchMs", "warmDispatch"],
      }[metric];
      const raw = aliases
        .map((name) => samples[name])
        .find((item) => item !== undefined);
      const values = typeof raw === "number" ? [raw] : raw;
      if (!Array.isArray(values)) {
        throw new Error(`Missing ${metric} samples`);
      }
      return [metric, values];
    }),
  );
}

export function evaluateGates(samples, gates = NATIVE_TUI_GATES) {
  const normalized = normalizeSamples(samples);
  const metrics = Object.fromEntries(
    METRICS.map((metric) => {
      const summary = summarizeSamples(normalized[metric]);
      const thresholdMs = gates[metric];
      return [
        metric,
        {
          ...summary,
          thresholdMs,
          passed: summary.p95Ms < thresholdMs,
        },
      ];
    }),
  );
  return {
    schema: NATIVE_TUI_PERF_SCHEMA,
    thresholdsMs: { ...gates },
    metrics,
    passed: Object.values(metrics).every((metric) => metric.passed),
  };
}

export const summarize = summarizeSamples;
export const checkPerformanceGates = evaluateGates;

export async function readSamples(filePath) {
  return normalizeSamples(JSON.parse(await readFile(filePath, "utf8")));
}

function parsePositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return number;
}

export function parseArgs(argv) {
  const options = {
    fixture: DEFAULT_NATIVE_TUI_FIXTURE,
    injected: undefined,
    jsonPath: undefined,
    real: false,
    runs: 20,
    timeoutMs: 30_000,
    command: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new Error(`Missing value for ${arg}`);
      index += 1;
      return argv[index];
    };
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--fixture") options.fixture = path.resolve(next());
    else if (arg === "--samples") {
      const value = next();
      options.injected = value.startsWith("{")
        ? JSON.parse(value)
        : awaitReadPath(value);
    } else if (arg === "--json") {
      const value = argv[index + 1];
      options.jsonPath = value && !value.startsWith("--") ? next() : "-";
    } else if (arg === "--real") options.real = true;
    else if (arg === "--runs")
      options.runs = parsePositiveInteger(next(), "runs");
    else if (arg === "--timeout") {
      options.timeoutMs = parsePositiveInteger(next(), "timeout");
    } else if (arg === "--") {
      options.command = argv.slice(index + 1);
      break;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function awaitReadPath(filePath) {
  return { __path: path.resolve(filePath) };
}

async function injectedFromOption(option) {
  if (option?.__path) return readSamples(option.__path);
  return normalizeSamples(option);
}

function parseRealSample(stdout) {
  const lines = stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .reverse();
  for (const line of lines) {
    const candidate = line.startsWith("MINDCODE_NATIVE_TUI_BENCHMARK=")
      ? line.slice("MINDCODE_NATIVE_TUI_BENCHMARK=".length)
      : line;
    try {
      return normalizeSamples(JSON.parse(candidate));
    } catch {
      // Logs are allowed; the last JSON object is the benchmark result.
    }
  }
  throw new Error(
    "Real benchmark command must emit a JSON object with inputReadyMs, coldDispatchMs, and warmDispatchMs",
  );
}

function runRealOnce(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = spawn(command[0], command.slice(1), {
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const kill = () => {
      timedOut = true;
      try {
        if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(kill, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Real benchmark timed out after ${timeoutMs}ms`));
        return;
      }
      if (exitCode !== 0) {
        reject(
          new Error(`Real benchmark exited ${exitCode ?? signal}: ${stderr}`),
        );
        return;
      }
      try {
        const samples = parseRealSample(stdout);
        const elapsedMs = performance.now() - startedAt;
        resolve({ samples, elapsedMs });
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function runRealBenchmark(options) {
  if (!options.command?.length) return runNativeTuiBenchmark(options);
  const collected = Object.fromEntries(METRICS.map((metric) => [metric, []]));
  const elapsed = [];
  for (let index = 0; index < options.runs; index += 1) {
    const result = await runRealOnce(options.command, options.timeoutMs);
    for (const metric of METRICS)
      collected[metric].push(...result.samples[metric]);
    elapsed.push(result.elapsedMs);
  }
  return { samples: collected, elapsedMs: summarizeSamples(elapsed) };
}

const BENCHMARK_WARM_SAMPLES = 8;

async function runNativeTuiBenchmark(options) {
  if (process.platform === "win32") {
    throw new Error("The native TUI benchmark requires a Unix PTY");
  }
  const target = currentNativeTuiTarget();
  if (!target)
    throw new Error(
      `Unsupported benchmark host: ${process.platform}/${process.arch}`,
    );
  const root = path.resolve(import.meta.dirname, "../..");
  const outdir = path.join(root, "dist");
  const binaryPath =
    process.env.MINDCODE_NATIVE_TUI_PATH ??
    (existsSync(topLevelTuiPath(outdir, target))
      ? topLevelTuiPath(outdir, target)
      : tuiArtifactPath(root, target));
  if (!existsSync(binaryPath)) {
    throw new Error(
      `Native TUI benchmark binary does not exist: ${binaryPath}`,
    );
  }

  const collected = {
    inputReadyMs: [],
    coldDispatchMs: [],
    warmDispatchMs: [],
  };
  const elapsed = [];
  for (let index = 0; index < options.runs; index += 1) {
    const startedAt = performance.now();
    const sample = await runNativeTuiOnce(binaryPath, options.timeoutMs);
    collected.inputReadyMs.push(sample.inputReadyMs);
    collected.coldDispatchMs.push(sample.dispatchMs[0]);
    collected.warmDispatchMs.push(...sample.dispatchMs.slice(1));
    elapsed.push(performance.now() - startedAt);
  }
  return { samples: collected, elapsedMs: summarizeSamples(elapsed) };
}

async function runNativeTuiOnce(binaryPath, timeoutMs) {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mindcode-native-tui-perf-"),
  );
  const socketPath = path.join(directory, "control.sock");
  const server = createServer();
  let ptyProcess;
  let socket;
  let settled = false;
  let timer;
  let readyAt;
  let pendingAt;
  let inputCount = 0;
  const dispatchMs = [];

  const result = await new Promise((resolve, reject) => {
    const finish = async (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ptyProcess?.kill();
      } catch {}
      try {
        socket?.destroy();
        await new Promise((done) => server.close(() => done()));
      } catch {}
      await rm(directory, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(value);
    };
    const fail = (error) =>
      void finish(error instanceof Error ? error : new Error(String(error)));
    const successfulSample = () => ({
      inputReadyMs: readyAt - spawnAt,
      dispatchMs,
    });
    const requestInput = () => {
      pendingAt = performance.now();
      ptyProcess.write("a");
    };

    server.on("error", fail);
    server.on("connection", (client) => {
      socket = client;
      const decoder = new BenchmarkFrameDecoder();
      client.on("error", fail);
      client.on("data", (chunk) => {
        try {
          for (const message of decoder.push(chunk)) {
            if (message.type === "handshake") {
              client.write(
                encodeBenchmarkFrame({
                  type: "capabilities",
                  version: 1,
                  id: "benchmark",
                  capabilities: [
                    "render_snapshot",
                    "input",
                    "resize",
                    "shutdown",
                  ],
                }),
              );
              client.write(
                encodeBenchmarkFrame({
                  type: "render_snapshot",
                  version: 1,
                  id: "benchmark-snapshot",
                  sequence: 1,
                  status: { state: "running", message: "benchmark" },
                  tasks: [],
                  transcript: [],
                }),
              );
            } else if (
              message.type === "terminal_size" &&
              readyAt === undefined
            ) {
              readyAt = performance.now();
              requestInput();
            } else if (message.type === "input_event") {
              if (pendingAt === undefined)
                throw new Error("Input event arrived without a pending write");
              dispatchMs.push(performance.now() - pendingAt);
              pendingAt = undefined;
              inputCount += 1;
              client.write(
                encodeBenchmarkFrame({
                  type: "ack",
                  version: 1,
                  id: message.id,
                  sequence: message.sequence,
                }),
              );
              if (inputCount < BENCHMARK_WARM_SAMPLES + 1) requestInput();
              else ptyProcess.write("\x11");
            } else if (message.type === "shutdown") {
              void finish(null, successfulSample());
            }
          }
        } catch (error) {
          fail(error);
        }
      });
    });
    const spawnAt = performance.now();
    server.listen(socketPath, () => {
      importPtyBackend()
        .then(({ spawn: spawnPty }) => {
          ptyProcess = spawnPty(
            binaryPath,
            ["--control-socket", socketPath, "--session-id", "benchmark"],
            {
              name: "xterm-256color",
              cols: 120,
              rows: 40,
              env: { ...process.env, TERM: "xterm-256color" },
            },
          );
          ptyProcess.onExit(({ exitCode }) => {
            if (settled) return;
            if (
              exitCode === 0 &&
              readyAt !== undefined &&
              dispatchMs.length === BENCHMARK_WARM_SAMPLES + 1
            ) {
              void finish(null, successfulSample());
              return;
            }
            fail(
              new Error(
                `Native TUI exited before benchmark completion (${exitCode})`,
              ),
            );
          });
          ptyProcess.onData(() => {});
        })
        .catch(fail);
    });
    timer = setTimeout(
      () =>
        fail(new Error(`Native TUI benchmark timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return result;
}

function importPtyBackend() {
  return typeof globalThis.Bun === "undefined"
    ? import("node-pty")
    : import("bun-pty");
}

class BenchmarkFrameDecoder {
  buffered = Buffer.alloc(0);

  push(chunk) {
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages = [];
    while (this.buffered.length >= 4) {
      const size = this.buffered.readUInt32BE(0);
      if (size === 0 || size > 4 * 1024 * 1024)
        throw new Error("Invalid benchmark frame size");
      if (this.buffered.length < size + 4) break;
      messages.push(decode(this.buffered.subarray(4, size + 4)));
      this.buffered = this.buffered.subarray(size + 4);
    }
    return messages;
  }
}

function encodeBenchmarkFrame(message) {
  const payload = Buffer.from(encode(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function usage() {
  return "Usage: bun scripts/perf/native-tui-harness.mjs [options]\n\nOptions:\n  --fixture PATH       Deterministic injected sample fixture (default: tests/fixtures/native-tui-perf.json)\n  --samples PATH|JSON  Inject sample data instead of the fixture\n  --real [-- COMMAND]  Run the native PTY benchmark, or an external benchmark command\n  --runs N             Real command repetitions (default: 20)\n  --timeout MS         Real command timeout (default: 30000)\n  --json [PATH]        Write JSON to PATH or stdout\n";
}

export async function runHarness(options) {
  if (options.real) {
    const result = await runRealBenchmark(options);
    return {
      mode: "real",
      command: options.command,
      runs: options.runs,
      elapsed: result.elapsedMs,
      ...evaluateGates(result.samples),
    };
  }
  const samples = options.injected
    ? await injectedFromOption(options.injected)
    : await readSamples(options.fixture);
  return {
    mode: "fixture",
    fixture: options.injected ? null : options.fixture,
    ...evaluateGates(samples),
  };
}

if (import.meta.main) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage());
      process.exit(0);
    }
    const result = await runHarness(options);
    const json = `${JSON.stringify(result, null, 2)}\n`;
    if (options.jsonPath && options.jsonPath !== "-") {
      await writeFile(options.jsonPath, json, "utf8");
    } else {
      process.stdout.write(json);
    }
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : error}\n\n${usage()}`,
    );
    process.exitCode = 2;
  }
}
