import { describe, expect, test } from "bun:test";
import { CoreToolsProtocolError } from "./errors.js";
import {
  CORE_TOOLS_ARGV_MAX_BYTES,
  CORE_TOOLS_ARGV_MAX_ITEMS,
  CORE_TOOLS_ARG_MAX_BYTES,
  CORE_TOOLS_ENV_MAX_ENTRIES,
  CORE_TOOLS_OUTPUT_MAX_BYTES,
  CORE_TOOLS_OUTPUT_MIN_BYTES,
  CORE_TOOLS_STDIN_MAX_BYTES,
  CORE_TOOLS_TIMEOUT_MAX_MS,
  CORE_TOOLS_TIMEOUT_MIN_MS,
  validateGitDiffParams,
  validateGitDiffResult,
  validateGitStatusResult,
  validateProcessRunParams,
  validateProcessRunResult,
} from "./protocol.js";

describe("core tools wire protocol", () => {
  test("validates exact process params and preserves optional fields", () => {
    expect(
      validateProcessRunParams({
        argv: ["git", "status", ""],
        cwd: "/work/repo",
        env: { LANG: "C.UTF-8" },
        stdin: "input\n",
        timeout_ms: 500,
        max_output_bytes: 4096,
      }),
    ).toEqual({
      argv: ["git", "status", ""],
      cwd: "/work/repo",
      env: { LANG: "C.UTF-8" },
      stdin: "input\n",
      timeout_ms: 500,
      max_output_bytes: 4096,
    });
    expect(validateProcessRunParams({ argv: ["true"], cwd: "/work" })).toEqual({
      argv: ["true"],
      cwd: "/work",
    });
  });

  test("rejects unknown fields, unsafe integers, controls, and forbidden env", () => {
    const invalid: unknown[] = [
      { argv: ["true"], cwd: "/work", extra: true },
      { argv: ["true"], cwd: "/work", timeout_ms: 1.5 },
      { argv: ["true"], cwd: "/work\n" },
      { argv: ["true"], cwd: "/work", env: { VEXZY_API_KEY: "secret" } },
      { argv: ["true"], cwd: "/work", env: { Authorization: "token" } },
      { argv: ["true"], cwd: "/work", env: { PATH: "ok\0bad" } },
      { argv: [""], cwd: "/work" },
      { argv: ["true\n"], cwd: "/work" },
      { argv: ["true"], cwd: "/work", stdin: "bad\u0001input" },
      { argv: [], cwd: "/work" },
      { argv: ["true"], cwd: "relative" },
    ];
    for (const value of invalid) {
      expect(() => validateProcessRunParams(value)).toThrow(
        CoreToolsProtocolError,
      );
    }
  });

  test("enforces Rust process boundary limits and absolute cwd", () => {
    const sixteenKiB = "x".repeat(CORE_TOOLS_ARG_MAX_BYTES);
    const maxArgv = [sixteenKiB, sixteenKiB, sixteenKiB, sixteenKiB];
    expect(
      validateProcessRunParams({
        argv: maxArgv,
        cwd: "/work/repo",
        stdin: "x".repeat(CORE_TOOLS_STDIN_MAX_BYTES),
        timeout_ms: CORE_TOOLS_TIMEOUT_MIN_MS,
        max_output_bytes: CORE_TOOLS_OUTPUT_MIN_BYTES,
      }),
    ).toMatchObject({ argv: maxArgv, timeout_ms: 1, max_output_bytes: 1 });
    expect(
      validateProcessRunParams({
        argv: Array.from({ length: CORE_TOOLS_ARGV_MAX_ITEMS }, () => "x"),
        cwd: "C:\\work\\repo",
        timeout_ms: CORE_TOOLS_TIMEOUT_MAX_MS,
        max_output_bytes: CORE_TOOLS_OUTPUT_MAX_BYTES,
      }),
    ).toMatchObject({
      timeout_ms: 120_000,
      max_output_bytes: 8 * 1_024 * 1_024,
    });

    const tooManyArgs = Array.from(
      { length: CORE_TOOLS_ARGV_MAX_ITEMS + 1 },
      () => "x",
    );
    expect(() =>
      validateProcessRunParams({ argv: tooManyArgs, cwd: "/work" }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        stdin: "x".repeat(CORE_TOOLS_STDIN_MAX_BYTES + 1),
      }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunParams({ argv: ["x"], cwd: "/work", timeout_ms: 0 }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        timeout_ms: CORE_TOOLS_TIMEOUT_MAX_MS + 1,
      }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        max_output_bytes: 0,
      }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        max_output_bytes: CORE_TOOLS_OUTPUT_MAX_BYTES + 1,
      }),
    ).toThrow(CoreToolsProtocolError);
  });

  test("enforces env count and rejects credential-shaped names", () => {
    const env = Object.fromEntries(
      Array.from({ length: CORE_TOOLS_ENV_MAX_ENTRIES }, (_, index) => [
        `VAR_${index}`,
        "ok",
      ]),
    );
    expect(
      validateProcessRunParams({ argv: ["x"], cwd: "/work", env }),
    ).toMatchObject({ env });
    expect(() =>
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        env: { ...env, VAR_64: "too-many" },
      }),
    ).toThrow(CoreToolsProtocolError);
    for (const key of [
      "API_KEY",
      "service_access_key_value",
      "client_SECRET_VALUE",
      "session_token",
      "DB_PASSWORD",
      "DB_PASSWD",
      "OAUTH_CREDENTIAL_STORE",
      "TLS_PRIVATE_KEY_PEM",
      "HTTP_AUTHORIZATION_HEADER",
      "vexzy_api_key",
      "SERVICE_AUTH",
      "SESSION_COOKIE",
      "SSH_KEY",
    ]) {
      expect(() =>
        validateProcessRunParams({
          argv: ["x"],
          cwd: "/work",
          env: { [key]: "x" },
        }),
      ).toThrow(CoreToolsProtocolError);
    }
    expect(
      validateProcessRunParams({
        argv: ["x"],
        cwd: "/work",
        env: { TOKENIZED_NAME: "not-a-token-key" },
      }),
    ).toMatchObject({ env: { TOKENIZED_NAME: "not-a-token-key" } });
  });

  test("validates git result shapes strictly", () => {
    expect(
      validateGitStatusResult({
        root: "/work/repo",
        detached: false,
        staged: ["a.ts"],
        unstaged: [],
        untracked: ["b.ts"],
        conflicts: [],
      }),
    ).toEqual({
      root: "/work/repo",
      detached: false,
      staged: ["a.ts"],
      unstaged: [],
      untracked: ["b.ts"],
      conflicts: [],
    });
    expect(() =>
      validateGitStatusResult({
        root: "/work/repo",
        detached: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        extra: true,
      }),
    ).toThrow(CoreToolsProtocolError);
    expect(
      validateGitStatusResult({
        root: "/work/repo",
        branch: null,
        head: null,
        detached: true,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        changes: [
          { path: "added.ts", xy: "A." },
          { path: "renamed.ts", xy: "R." },
          { path: "copied.ts", xy: ".C" },
          { path: "conflict.ts", xy: "UU" },
        ],
      }),
    ).toMatchObject({ branch: null, head: null });
    expect(() =>
      validateGitStatusResult({
        root: "/work/repo",
        detached: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        changes: [{ path: "bad.ts", xy: "M" }],
      }),
    ).toThrow(CoreToolsProtocolError);
  });

  test("rejects malformed exact git XY codes", () => {
    expect(() =>
      validateGitStatusResult({
        root: "/work/repo",
        detached: false,
        staged: [],
        unstaged: [],
        untracked: [],
        conflicts: [],
        changes: [{ path: "bad.ts", xy: "M " }],
      }),
    ).toThrow(CoreToolsProtocolError);
  });

  test("bounds git diff inputs and process outputs", () => {
    expect(() =>
      validateGitDiffParams({ cwd: "/work", paths: ["bad\tpath"] }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateProcessRunResult({
        exit_code: 0,
        signal: null,
        stdout: "x".repeat(CORE_TOOLS_OUTPUT_MAX_BYTES + 1),
        stderr: "",
        timed_out: false,
        truncated: false,
        duration_ms: 1,
      }),
    ).toThrow(CoreToolsProtocolError);
    expect(() =>
      validateGitDiffResult({ root: "/work", patch: "ok", truncated: "no" }),
    ).toThrow(CoreToolsProtocolError);
  });
});
