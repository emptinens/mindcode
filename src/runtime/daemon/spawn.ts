import { spawn } from "node:child_process";
import {
  resolveDaemonExecutablePath,
  resolveDaemonSocketPath,
} from "./path.js";
import type { DaemonSpawnOptions, DaemonSpawnResult } from "./types.js";

const DAEMON_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TEMPDIR",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "COLORTERM",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "BUN_INSTALL",
  "RUST_LOG",
  "RUST_BACKTRACE",
  "NODE_ENV",
]);

const SECRET_ENV_KEY =
  /(?:^|[_-])(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY|AUTH(?:ORIZATION)?)(?:$|[_-])/i;

function isAllowedDaemonEnvKey(key: string): boolean {
  return (
    DAEMON_ENV_KEYS.has(key) ||
    key.startsWith("LC_") ||
    key.startsWith("MINDCODE_") ||
    key.startsWith("XDG_")
  );
}

function isSecretDaemonEnvKey(key: string): boolean {
  return key === "VEXZY_API_KEY" || SECRET_ENV_KEY.test(key);
}

export function sanitizeDaemonEnvironment(
  base: NodeJS.ProcessEnv = process.env,
  overrides: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const merged = { ...base, ...overrides };
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(merged)) {
    if (
      value !== undefined &&
      isAllowedDaemonEnvKey(key) &&
      !isSecretDaemonEnvKey(key)
    ) {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/** Spawn the detached sidecar used by the lazy daemon manager. */
export function spawnMindcodeDaemon(
  options: DaemonSpawnOptions = {},
): DaemonSpawnResult {
  const socketPath = options.socketPath ?? resolveDaemonSocketPath();
  const executablePath =
    options.executablePath ?? resolveDaemonExecutablePath();
  const args = options.args ? [...options.args] : ["--socket", socketPath];
  const child = spawn(executablePath, args, {
    cwd: options.cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...sanitizeDaemonEnvironment(process.env, options.env),
      MINDCODE_DAEMON_SOCKET: socketPath,
    },
  });
  // Detached children do not have a parent to consume an asynchronous spawn
  // error. Keep an error listener installed even when callers do not need the
  // event; the manager adds its own listener for lifecycle accounting.
  child.once("error", () => undefined);
  child.unref();
  return { executablePath, socketPath, process: child };
}
