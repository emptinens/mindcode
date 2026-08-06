import {
  CoreToolsDaemonClient,
  type GitStatusResult,
} from "../runtime/coreTools/client.js";
import { getCwd } from "./cwd.js";
import { execFileNoThrowWithCwd } from "./execFileNoThrow.js";
import { findGitRoot, gitExe } from "./git.js";

const STATUS_ARGS = ["--no-optional-locks", "status", "--short"];

export type CoreToolsGitClient = Pick<
  CoreToolsDaemonClient,
  "gitStatusWithFallback"
>;

export type CoreToolsGitAdapterOptions = {
  client?: CoreToolsGitClient;
  cwd?: string;
  runStatus?: (cwd: string) => Promise<string>;
};

/**
 * Convert the structured daemon result to a deterministic porcelain-like
 * status. The daemon deliberately exposes status dimensions instead of raw
 * porcelain text, so this is the single formatting boundary for startup
 * context consumers.
 */
export function formatGitStatus(result: GitStatusResult): string {
  const entries = new Map<string, string>();
  const exactChanges = result.changes ?? [];
  const exactPaths = new Set<string>();

  for (const change of exactChanges) {
    entries.set(change.path, change.xy.replaceAll(".", " "));
    exactPaths.add(change.path);
  }

  const conflicts = new Set(result.conflicts);
  for (const path of conflicts) {
    if (!exactPaths.has(path)) entries.set(path, "UU");
  }

  for (const path of result.staged) {
    if (exactPaths.has(path) || conflicts.has(path)) continue;
    const code = entries.get(path) ?? "  ";
    entries.set(path, `M${code[1]}`);
  }

  for (const path of result.unstaged) {
    if (exactPaths.has(path) || conflicts.has(path)) continue;
    const code = entries.get(path) ?? "  ";
    entries.set(path, `${code[0]}M`);
  }

  const lines = [...entries.entries()]
    .sort(([left], [right]) => comparePaths(left, right))
    .map(([path, xy]) => `${xy} ${path}`);

  const untracked = [...new Set(result.untracked)]
    .sort(comparePaths)
    .map((path) => `?? ${path}`);

  return [...lines, ...untracked].join("\n");
}

/**
 * Read the startup status through CoreToolsDaemonClient. The fallback keeps
 * the previous git subprocess invocation and returns its exact trimmed
 * output; only the daemon path is normalized from structured status.
 */
export async function readGitStatusWithFallback(
  options: CoreToolsGitAdapterOptions = {},
): Promise<string> {
  const cwd = options.cwd ?? getCwd();
  const client = options.client ?? new CoreToolsDaemonClient();
  let fallbackOutput: string | undefined;

  const result = await client.gitStatusWithFallback(
    { cwd, include_untracked: true },
    async () => {
      const output = (await (options.runStatus ?? runGitStatus)(cwd)).trim();
      fallbackOutput = output;
      return parseFallbackStatus(cwd, output);
    },
  );

  return result.source === "fallback" && fallbackOutput !== undefined
    ? fallbackOutput
    : formatGitStatus(result.value);
}

async function runGitStatus(cwd: string): Promise<string> {
  const { stdout } = await execFileNoThrowWithCwd(gitExe(), STATUS_ARGS, {
    cwd,
    env: getSafeGitEnvironment(),
    preserveOutputOnError: false,
  });
  return stdout.trim();
}

export function getSafeGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && isSafeInheritedKey(key)) {
      environment[key] = value;
    }
  }
  return environment;
}

function isSafeInheritedKey(key: string): boolean {
  return (
    key === "PATH" ||
    key === "HOME" ||
    key === "TMPDIR" ||
    key === "TERM" ||
    key === "LANG" ||
    key.startsWith("LC_") ||
    key === "SystemRoot" ||
    key === "ComSpec" ||
    key === "PATHEXT" ||
    key === "WINDIR"
  );
}

function parseFallbackStatus(cwd: string, output: string): GitStatusResult {
  const staged: string[] = [];
  const unstaged: string[] = [];
  const untracked: string[] = [];
  const conflicts: string[] = [];
  const changes: { path: string; xy: string }[] = [];

  for (const line of output.split(/\r?\n/)) {
    if (line.length < 3 || line.trim() === "") continue;
    const code = line.slice(0, 2);
    const path = line.slice(3);
    if (!path) continue;

    if (code === "??") {
      untracked.push(path);
    } else if (code.includes("U")) {
      conflicts.push(path);
      changes.push({ path, xy: code });
    } else {
      changes.push({ path, xy: code });
      if (code[0] !== " " && code[0] !== ".") staged.push(path);
      if (code[1] !== " " && code[1] !== ".") unstaged.push(path);
    }
  }

  return {
    root: findGitRoot(cwd) ?? cwd,
    detached: false,
    staged,
    unstaged,
    untracked,
    conflicts,
    changes,
  };
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
