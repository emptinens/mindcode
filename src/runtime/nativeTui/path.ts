import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const NATIVE_TUI_PATH_ENV = "MINDCODE_NATIVE_TUI_PATH" as const;
export const NATIVE_TUI_EXECUTABLE_NAME = "mindcode-tui" as const;

export type NativeTuiRuntimePathOptions = {
  runtimePath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
};

/**
 * Resolve the foreground TUI next to the CLI runtime.
 *
 * A compiled bundle ships `mindcode-tui` beside `mindcode`. Target-qualified
 * distributions ship `mindcode-tui-<platform>-<arch>` instead. The fallback
 * path is deterministic even when neither file is present so callers can
 * report a typed missing-binary result without guessing a path.
 */
export function resolveNativeTuiExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  options: NativeTuiRuntimePathOptions = {},
): string {
  const configured = env[NATIVE_TUI_PATH_ENV]?.trim();
  if (configured) return configured;

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const runtimePath = options.runtimePath ?? process.execPath;
  const executableName =
    platform === "win32"
      ? `${NATIVE_TUI_EXECUTABLE_NAME}.exe`
      : NATIVE_TUI_EXECUTABLE_NAME;
  const runtimeDirectory = dirname(runtimePath);
  const bundleSibling = join(runtimeDirectory, executableName);
  const qualifiedSibling = join(
    runtimeDirectory,
    `${executableName}-${platform}-${normalizeArchitecture(arch)}`,
  );
  const exists = options.exists ?? existsSync;

  if (exists(bundleSibling)) return bundleSibling;
  if (exists(qualifiedSibling)) return qualifiedSibling;
  return bundleSibling;
}

export const resolveNativeTuiPath = resolveNativeTuiExecutablePath;
export const resolveNativeTuiBinaryPath = resolveNativeTuiExecutablePath;
export const resolveNativeTuiExecutable = resolveNativeTuiExecutablePath;

function normalizeArchitecture(arch: string): string {
  return arch === "x86_64" ? "x64" : arch === "aarch64" ? "arm64" : arch;
}
