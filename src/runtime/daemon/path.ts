import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const DEFAULT_DAEMON_SOCKET_PATH = join(
  homedir(),
  ".mindcode",
  "run",
  "mindcoded-v1.sock",
);

export function resolveDaemonSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MINDCODE_DAEMON_SOCKET?.trim();
  if (!configured) return DEFAULT_DAEMON_SOCKET_PATH;
  if (configured === "~") return homedir();
  if (configured.startsWith("~/")) return join(homedir(), configured.slice(2));
  return configured;
}

export function resolveDaemonExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configured = env.MINDCODE_DAEMON_PATH?.trim();
  if (configured) return configured;

  const executableName =
    process.platform === "win32" ? "mindcoded.exe" : "mindcoded";
  const packageLocal = join(dirname(process.execPath), executableName);
  if (isAbsolute(packageLocal)) return packageLocal;
  return resolve(homedir(), ".mindcode", "bin", executableName);
}
