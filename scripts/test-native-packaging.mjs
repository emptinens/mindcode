#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { decode, encode } from "@msgpack/msgpack";
import {
  currentBunTarget,
  resolvePackagedDaemonPath,
  selectBunTargets,
  targetBundleDirectory,
  topLevelMindcodePath,
  validateNativePackage,
} from "./native-daemon.mjs";

const root = path.resolve(import.meta.dirname, "..");
const outdir = path.resolve(process.argv[2] ?? path.join(root, "dist"));
const targets = selectBunTargets({ env: process.env });

for (const target of targets) {
  const result = await validateNativePackage({ outdir, target });
  const manifestPath = path.join(
    targetBundleDirectory(outdir, target),
    "manifest.json",
  );
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    result.bunTarget !== target.bunTarget ||
    manifest.bunTarget !== target.bunTarget
  ) {
    throw new Error(`Target mismatch in ${manifestPath}`);
  }
  if (target.rustTarget) {
    const daemon = path.join(
      targetBundleDirectory(outdir, target),
      "mindcoded",
    );
    if (!existsSync(daemon) || (statSync(daemon).mode & 0o111) === 0) {
      throw new Error(`Daemon is missing or not executable: ${daemon}`);
    }
    const topLevelDaemon = resolvePackagedDaemonPath({
      outdir,
      target,
      executablePath: topLevelMindcodePath(outdir, target),
    });
    if (
      !existsSync(topLevelDaemon) ||
      (statSync(topLevelDaemon).mode & 0o111) === 0
    ) {
      throw new Error(
        `Target-qualified daemon is missing or not executable: ${topLevelDaemon}`,
      );
    }
  }
}

async function readFrame(socket) {
  return new Promise((resolve, reject) => {
    let buffered = Buffer.alloc(0);
    const onData = (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 4) return;
      const length = buffered.readUInt32BE(0);
      if (buffered.length < length + 4) return;
      socket.off("data", onData);
      resolve(decode(buffered.subarray(4, length + 4)));
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.once("close", () =>
      reject(new Error("daemon closed before response")),
    );
  });
}

function writeFrame(socket, message) {
  const payload = Buffer.from(encode(message));
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  socket.write(frame);
}

async function waitForSocket(socketPath) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for native daemon socket ${socketPath}`);
}

async function smokeDaemon(target, outdir) {
  if (target.bunTarget !== currentBunTarget()) {
    console.log(
      `Skipping daemon execution for non-host target ${target.bunTarget}`,
    );
    return;
  }
  const daemonPath = resolvePackagedDaemonPath({
    outdir,
    target,
    executablePath: topLevelMindcodePath(outdir, target),
  });
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "mindcode-daemon-smoke-"),
  );
  const socketPath = path.join(directory, "mindcoded-v1.sock");
  const child = spawn(
    daemonPath,
    ["--socket", socketPath, "--idle-seconds", "30"],
    {
      stdio: "ignore",
    },
  );
  let socket;
  try {
    socket = await waitForSocket(socketPath);
    writeFrame(socket, {
      type: "handshake",
      id: "native-package-smoke-handshake",
      version: 1,
      client: "mindcode-native-package-smoke",
      capabilities: ["ping", "shutdown"],
    });
    const response = await readFrame(socket);
    if (
      response.type !== "handshake_ack" ||
      response.accepted !== true ||
      response.version !== 1
    ) {
      throw new Error(
        `Invalid native daemon handshake response: ${JSON.stringify(response)}`,
      );
    }
    writeFrame(socket, {
      type: "request",
      id: "native-package-smoke-shutdown",
      method: "shutdown",
      params: {},
    });
    await readFrame(socket);
    console.log(`Native daemon handshake passed: ${target.bunTarget}`);
  } finally {
    socket?.destroy();
    if (!child.killed) child.kill();
    await rm(directory, { recursive: true, force: true });
  }
}

for (const target of targets) {
  if (target.rustTarget) await smokeDaemon(target, outdir);
}

console.log(
  `Native packaging smoke check passed: ${targets.map(({ bunTarget }) => bunTarget).join(", ")}`,
);
