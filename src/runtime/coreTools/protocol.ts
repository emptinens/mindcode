import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { CoreToolsProtocolError } from "./errors.js";

export const PROCESS_RUN_METHOD = "process.run" as const;
export const GIT_ROOT_METHOD = "git.root" as const;
export const GIT_STATUS_METHOD = "git.status" as const;
export const GIT_DIFF_METHOD = "git.diff" as const;
export const GIT_REV_PARSE_METHOD = "git.rev_parse" as const;

export const CORE_TOOLS_METHODS = [
  PROCESS_RUN_METHOD,
  GIT_ROOT_METHOD,
  GIT_STATUS_METHOD,
  GIT_DIFF_METHOD,
  GIT_REV_PARSE_METHOD,
] as const;

export const CORE_TOOLS_PATH_MAX_BYTES = 16 * 1_024;
export const CORE_TOOLS_ARG_MAX_BYTES = 16 * 1_024;
export const CORE_TOOLS_ARGV_MAX_ITEMS = 128;
export const CORE_TOOLS_ARGV_MAX_BYTES = 64 * 1_024;
export const CORE_TOOLS_ENV_MAX_ENTRIES = 64;
export const CORE_TOOLS_ENV_KEY_MAX_BYTES = 256;
export const CORE_TOOLS_ENV_VALUE_MAX_BYTES = 64 * 1_024;
export const CORE_TOOLS_ENV_MAX_BYTES = 4 * 1_024 * 1_024;
export const CORE_TOOLS_STDIN_MAX_BYTES = 1 * 1_024 * 1_024;
export const CORE_TOOLS_TIMEOUT_MIN_MS = 1;
export const CORE_TOOLS_TIMEOUT_MAX_MS = 120_000;
export const CORE_TOOLS_OUTPUT_MIN_BYTES = 1;
export const CORE_TOOLS_OUTPUT_MAX_BYTES = 8 * 1_024 * 1_024;
export const CORE_TOOLS_PATHS_MAX_ITEMS = 128;
export const CORE_TOOLS_CONTEXT_LINES_MAX = 100_000;

export type CoreToolsRequestOptions = DaemonRequestOptions;

export type ProcessRunParams = {
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeout_ms?: number;
  max_output_bytes?: number;
};

export type ProcessRunResult = {
  exit_code: number | null;
  signal: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
  truncated: boolean;
  duration_ms: number;
};

export type GitRootParams = { cwd: string };
export type GitRootResult = { root: string | null };

export type GitStatusParams = {
  cwd: string;
  include_untracked?: boolean;
};

export type GitStatusResult = {
  root: string;
  branch?: string | null;
  head?: string | null;
  detached: boolean;
  staged: string[];
  unstaged: string[];
  untracked: string[];
  conflicts: string[];
  changes?: GitStatusChange[];
};

export type GitStatusChange = {
  path: string;
  xy: string;
};

export type GitDiffParams = {
  cwd: string;
  staged?: boolean;
  paths?: string[];
  context_lines?: number;
  max_output_bytes?: number;
};

export type GitDiffResult = {
  root: string;
  patch: string;
  truncated: boolean;
};

export type GitRevParseParams = {
  cwd: string;
  revision?: string;
};

export type GitRevParseResult = { value: string | null };

export type CoreToolsResponse = {
  [PROCESS_RUN_METHOD]: ProcessRunResult;
  [GIT_ROOT_METHOD]: GitRootResult;
  [GIT_STATUS_METHOD]: GitStatusResult;
  [GIT_DIFF_METHOD]: GitDiffResult;
  [GIT_REV_PARSE_METHOD]: GitRevParseResult;
};

export type CoreToolsDaemonTransport = {
  request?: <T>(
    method: string,
    params?: unknown,
    options?: CoreToolsRequestOptions,
  ) => Promise<T>;
  requestWithFallback?: <T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options?: CoreToolsRequestOptions,
  ) => Promise<DaemonCallResult<T>>;
};

const textEncoder = new TextEncoder();
export function validateProcessRunParams(
  value: unknown,
  context = "process.run params",
): ProcessRunParams {
  const object = exact(
    value,
    ["argv", "cwd", "env", "stdin", "timeout_ms", "max_output_bytes"],
    context,
  );
  const argvValue = required(object, "argv", context);
  if (!Array.isArray(argvValue) || argvValue.length === 0) {
    throw protocol(`${context}.argv must be a non-empty array`);
  }
  if (argvValue.length > CORE_TOOLS_ARGV_MAX_ITEMS) {
    throw protocol(`${context}.argv exceeds the maximum item count`);
  }
  let argvBytes = 0;
  const argv = argvValue.map((item, index) => {
    const argument = safeText(
      item,
      `${context}.argv[${index}]`,
      CORE_TOOLS_ARG_MAX_BYTES,
      index > 0,
    );
    argvBytes += byteLength(argument);
    return argument;
  });
  if (argvBytes > CORE_TOOLS_ARGV_MAX_BYTES) {
    throw protocol(`${context}.argv exceeds the maximum byte length`);
  }

  const params: ProcessRunParams = {
    argv,
    cwd: absolutePath(required(object, "cwd", context), `${context}.cwd`),
  };
  if (has(object, "env")) {
    params.env = envValue(object.env, `${context}.env`);
  }
  if (has(object, "stdin")) {
    params.stdin = inputText(object.stdin, `${context}.stdin`);
  }
  if (has(object, "timeout_ms")) {
    params.timeout_ms = boundedInteger(
      object.timeout_ms,
      `${context}.timeout_ms`,
      CORE_TOOLS_TIMEOUT_MIN_MS,
      CORE_TOOLS_TIMEOUT_MAX_MS,
    );
  }
  if (has(object, "max_output_bytes")) {
    params.max_output_bytes = boundedInteger(
      object.max_output_bytes,
      `${context}.max_output_bytes`,
      CORE_TOOLS_OUTPUT_MIN_BYTES,
      CORE_TOOLS_OUTPUT_MAX_BYTES,
    );
  }
  return params;
}

export function validateGitRootParams(
  value: unknown,
  context = "git.root params",
): GitRootParams {
  const object = exact(value, ["cwd"], context);
  return {
    cwd: absolutePath(required(object, "cwd", context), `${context}.cwd`),
  };
}

export function validateGitStatusParams(
  value: unknown,
  context = "git.status params",
): GitStatusParams {
  const object = exact(value, ["cwd", "include_untracked"], context);
  const params: GitStatusParams = {
    cwd: absolutePath(required(object, "cwd", context), `${context}.cwd`),
  };
  if (has(object, "include_untracked")) {
    params.include_untracked = booleanValue(
      object.include_untracked,
      `${context}.include_untracked`,
    );
  }
  return params;
}

export function validateGitDiffParams(
  value: unknown,
  context = "git.diff params",
): GitDiffParams {
  const object = exact(
    value,
    ["cwd", "staged", "paths", "context_lines", "max_output_bytes"],
    context,
  );
  const params: GitDiffParams = {
    cwd: absolutePath(required(object, "cwd", context), `${context}.cwd`),
  };
  if (has(object, "staged")) {
    params.staged = booleanValue(object.staged, `${context}.staged`);
  }
  if (has(object, "paths")) {
    params.paths = pathsValue(object.paths, `${context}.paths`);
  }
  if (has(object, "context_lines")) {
    params.context_lines = boundedInteger(
      object.context_lines,
      `${context}.context_lines`,
      0,
      CORE_TOOLS_CONTEXT_LINES_MAX,
    );
  }
  if (has(object, "max_output_bytes")) {
    params.max_output_bytes = boundedInteger(
      object.max_output_bytes,
      `${context}.max_output_bytes`,
      CORE_TOOLS_OUTPUT_MIN_BYTES,
      CORE_TOOLS_OUTPUT_MAX_BYTES,
    );
  }
  return params;
}

export function validateGitRevParseParams(
  value: unknown,
  context = "git.rev_parse params",
): GitRevParseParams {
  const object = exact(value, ["cwd", "revision"], context);
  const params: GitRevParseParams = {
    cwd: absolutePath(required(object, "cwd", context), `${context}.cwd`),
  };
  if (has(object, "revision")) {
    params.revision = safeText(
      object.revision,
      `${context}.revision`,
      CORE_TOOLS_ARG_MAX_BYTES,
      false,
    );
  }
  return params;
}

export function validateProcessRunResult(
  value: unknown,
  context = "process.run result",
): ProcessRunResult {
  const object = exact(
    value,
    [
      "exit_code",
      "signal",
      "stdout",
      "stderr",
      "timed_out",
      "truncated",
      "duration_ms",
    ],
    context,
  );
  return {
    exit_code: nullableSafeInteger(
      required(object, "exit_code", context),
      `${context}.exit_code`,
    ),
    signal: nullableSafeInteger(
      required(object, "signal", context),
      `${context}.signal`,
    ),
    stdout: outputText(
      required(object, "stdout", context),
      `${context}.stdout`,
    ),
    stderr: outputText(
      required(object, "stderr", context),
      `${context}.stderr`,
    ),
    timed_out: booleanValue(
      required(object, "timed_out", context),
      `${context}.timed_out`,
    ),
    truncated: booleanValue(
      required(object, "truncated", context),
      `${context}.truncated`,
    ),
    duration_ms: nonNegativeSafeInteger(
      required(object, "duration_ms", context),
      `${context}.duration_ms`,
    ),
  };
}

export function validateGitRootResult(
  value: unknown,
  context = "git.root result",
): GitRootResult {
  const object = exact(value, ["root"], context);
  const root = required(object, "root", context);
  return { root: root === null ? null : pathValue(root, `${context}.root`) };
}

export function validateGitStatusResult(
  value: unknown,
  context = "git.status result",
): GitStatusResult {
  const object = exact(
    value,
    [
      "root",
      "branch",
      "head",
      "detached",
      "staged",
      "unstaged",
      "untracked",
      "conflicts",
      "changes",
    ],
    context,
  );
  const result: GitStatusResult = {
    root: pathValue(required(object, "root", context), `${context}.root`),
    detached: booleanValue(
      required(object, "detached", context),
      `${context}.detached`,
    ),
    staged: pathsValue(
      required(object, "staged", context),
      `${context}.staged`,
    ),
    unstaged: pathsValue(
      required(object, "unstaged", context),
      `${context}.unstaged`,
    ),
    untracked: pathsValue(
      required(object, "untracked", context),
      `${context}.untracked`,
    ),
    conflicts: pathsValue(
      required(object, "conflicts", context),
      `${context}.conflicts`,
    ),
  };
  if (has(object, "branch")) {
    result.branch = nullablePathText(object.branch, `${context}.branch`);
  }
  if (has(object, "head")) {
    result.head = nullablePathText(object.head, `${context}.head`);
  }
  if (has(object, "changes")) {
    result.changes = changesValue(object.changes, `${context}.changes`);
  }
  return result;
}

export function validateGitDiffResult(
  value: unknown,
  context = "git.diff result",
): GitDiffResult {
  const object = exact(value, ["root", "patch", "truncated"], context);
  return {
    root: pathValue(required(object, "root", context), `${context}.root`),
    patch: outputText(required(object, "patch", context), `${context}.patch`),
    truncated: booleanValue(
      required(object, "truncated", context),
      `${context}.truncated`,
    ),
  };
}

export function validateGitRevParseResult(
  value: unknown,
  context = "git.rev_parse result",
): GitRevParseResult {
  const object = exact(value, ["value"], context);
  const result = required(object, "value", context);
  return {
    value:
      result === null
        ? null
        : safeText(result, `${context}.value`, CORE_TOOLS_ARG_MAX_BYTES, false),
  };
}

function envValue(value: unknown, context: string): Record<string, string> {
  if (!isRecord(value)) throw protocol(`${context} must be an object`);
  const keys = Object.keys(value);
  if (keys.length > CORE_TOOLS_ENV_MAX_ENTRIES) {
    throw protocol(`${context} exceeds the maximum entry count`);
  }
  const env: Record<string, string> = {};
  let totalBytes = 0;
  for (const key of keys) {
    safeText(key, `${context} key`, CORE_TOOLS_ENV_KEY_MAX_BYTES, false);
    if (isCredentialShapedKey(key)) {
      throw protocol(`${context}.${key} is forbidden`);
    }
    const item = safeText(
      value[key],
      `${context}.${key}`,
      CORE_TOOLS_ENV_VALUE_MAX_BYTES,
      true,
    );
    totalBytes += byteLength(key) + byteLength(item);
    env[key] = item;
  }
  if (totalBytes > CORE_TOOLS_ENV_MAX_BYTES) {
    throw protocol(`${context} exceeds the maximum byte length`);
  }
  return env;
}

function isCredentialShapedKey(key: string): boolean {
  const normalized = key.toUpperCase().replaceAll(/[-.]/g, "_");
  if (normalized === "VEXZY_API_KEY" || normalized === "AUTHORIZATION") {
    return true;
  }
  const words = normalized.split("_");
  return (
    words.some((word) =>
      [
        "AUTH",
        "AUTHORIZATION",
        "TOKEN",
        "SECRET",
        "PASSWORD",
        "PASSWD",
        "CREDENTIAL",
        "CREDENTIALS",
        "COOKIE",
        "BEARER",
      ].includes(word),
    ) ||
    (words.includes("API") && words.includes("KEY")) ||
    (words.includes("PRIVATE") && words.includes("KEY")) ||
    (words.includes("ACCESS") && words.includes("KEY")) ||
    normalized.endsWith("_KEY")
  );
}

function pathsValue(value: unknown, context: string): string[] {
  if (!Array.isArray(value)) throw protocol(`${context} must be an array`);
  if (value.length > CORE_TOOLS_PATHS_MAX_ITEMS) {
    throw protocol(`${context} exceeds the maximum item count`);
  }
  return value.map((item, index) => pathValue(item, `${context}[${index}]`));
}

function pathValue(value: unknown, context: string): string {
  return safeText(value, context, CORE_TOOLS_PATH_MAX_BYTES, false);
}

function nullablePathText(value: unknown, context: string): string | null {
  return value === null ? null : pathValue(value, context);
}

function changesValue(value: unknown, context: string): GitStatusChange[] {
  if (!Array.isArray(value)) throw protocol(`${context} must be an array`);
  if (value.length > CORE_TOOLS_PATHS_MAX_ITEMS) {
    throw protocol(`${context} exceeds the maximum item count`);
  }
  return value.map((item, index) => {
    const change = exact(item, ["path", "xy"], `${context}[${index}]`);
    const xy = safeText(
      required(change, "xy", `${context}[${index}]`),
      `${context}[${index}].xy`,
      2,
      false,
    );
    if (xy.length !== 2 || xy.includes(" ")) {
      throw protocol(`${context}[${index}].xy must be an exact two-character status code`);
    }
    return {
      path: pathValue(
        required(change, "path", `${context}[${index}]`),
        `${context}[${index}].path`,
      ),
      xy,
    };
  });
}

function absolutePath(value: unknown, context: string): string {
  const path = pathValue(value, context);
  if (
    !path.startsWith("/") &&
    !/^[A-Za-z]:[\\/]/.test(path) &&
    !/^\\\\[^\\/]+[\\/][^\\/]+/.test(path) &&
    !/^\/\/[^/]+\/[^/]+/.test(path)
  ) {
    throw protocol(`${context} must be an absolute POSIX or Windows path`);
  }
  return path;
}

function outputText(value: unknown, context: string): string {
  return boundedString(value, context, CORE_TOOLS_OUTPUT_MAX_BYTES, true);
}

function inputText(value: unknown, context: string): string {
  const result = boundedString(
    value,
    context,
    CORE_TOOLS_STDIN_MAX_BYTES,
    true,
  );
  for (const character of result) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 32 &&
        codePoint !== 9 &&
        codePoint !== 10 &&
        codePoint !== 13) ||
      codePoint === 127
    ) {
      throw protocol(`${context} contains forbidden control characters`);
    }
  }
  return result;
}

function safeText(
  value: unknown,
  context: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  const result = boundedString(value, context, maxBytes, allowEmpty);
  for (const character of result) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint < 32 || codePoint === 127) {
      throw protocol(`${context} contains forbidden control characters`);
    }
  }
  return result;
}

function boundedString(
  value: unknown,
  context: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string") throw protocol(`${context} must be a string`);
  if (!allowEmpty && value.length === 0) {
    throw protocol(`${context} must not be empty`);
  }
  if (byteLength(value) > maxBytes) {
    throw protocol(`${context} exceeds the maximum byte length`);
  }
  return value;
}

function nullableSafeInteger(value: unknown, context: string): number | null {
  if (value !== null && !Number.isSafeInteger(value)) {
    throw protocol(`${context} must be a safe integer or null`);
  }
  return value as number | null;
}

function nonNegativeSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocol(`${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function boundedInteger(
  value: unknown,
  context: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw protocol(`${context} must be between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean")
    throw protocol(`${context} must be a boolean`);
  return value;
}

function exact(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw protocol(`${context} must be an object`);
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key))
      throw protocol(`${context} contains an unknown field`);
  }
  return value;
}

function required(
  object: Record<string, unknown>,
  key: string,
  context: string,
): unknown {
  if (!has(object, key)) throw protocol(`${context}.${key} is required`);
  return object[key];
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function protocol(message: string): CoreToolsProtocolError {
  return new CoreToolsProtocolError(message);
}
