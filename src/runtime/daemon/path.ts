import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const DEFAULT_DAEMON_SOCKET_PATH = join(
  homedir(),
  ".mindcode",
  "run",
  "mindcoded-v1.sock",
);

export type DaemonRuntimePathOptions = {
  runtimePath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
};

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
  options: DaemonRuntimePathOptions = {},
): string {
  const configured = env.MINDCODE_DAEMON_PATH?.trim();
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runtimePath = options.runtimePath ?? process.execPath;
  const executableName = platform === "win32" ? "mindcoded.exe" : "mindcoded";
  const target = `${platform}-${normalizeArchitecture(arch)}`;
  const runtimeDirectory = dirname(runtimePath);
  const bundleSibling = join(runtimeDirectory, executableName);
  const qualifiedSibling = join(
    runtimeDirectory,
    `${executableName}-${target}`,
  );

  // Bundles place the sidecar beside the CLI as `mindcoded`; standalone
  // target-qualified distributions place it beside `mindcode-<target>`.
  // Keep the order stable and only select an existing candidate so a bundled
  // CLI cannot accidentally resolve a daemon from another layout.
  if (existsSync(bundleSibling)) return bundleSibling;
  if (existsSync(qualifiedSibling)) return qualifiedSibling;
  return bundleSibling;
}

function normalizeArchitecture(arch: string): string {
  return arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
}
