import { describe, expect, test } from "bun:test";
import {
  DaemonCancelledError,
  DaemonDisabledError,
  DaemonRemoteError,
  DaemonTimeoutError,
} from "../daemon/errors.js";
import type { DaemonRequestOptions } from "../daemon/types.js";
import { CoreToolsDaemonClient } from "./client.js";
import { CoreToolsProtocolError } from "./errors.js";
import type { CoreToolsDaemonTransport } from "./protocol.js";

const processResult = {
  exit_code: 0,
  signal: null,
  stdout: "ok",
  stderr: "",
  timed_out: false,
  truncated: false,
  duration_ms: 2,
};
const rootResult = { root: "/work/repo" };
const statusResult = {
  root: "/work/repo",
  branch: "main",
  head: "abc123",
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
};
const diffResult = { root: "/work/repo", patch: "diff", truncated: false };
const revParseResult = { value: "abc123" };

function transportFor(
  responseByMethod: Record<string, unknown>,
): CoreToolsDaemonTransport & {
  calls: Array<{
    method: string;
    params: unknown;
    options?: DaemonRequestOptions;
  }>;
} {
  const calls: Array<{
    method: string;
    params: unknown;
    options?: DaemonRequestOptions;
  }> = [];
  return {
    calls,
    async request<T>(
      method: string,
      params: unknown,
      options?: DaemonRequestOptions,
    ) {
      calls.push({ method, params, options });
      return responseByMethod[method] as T;
    },
  };
}

describe("core tools client", () => {
  test("dispatches exact RPC methods and forwards request options", async () => {
    const controller = new AbortController();
    const transport = transportFor({
      "process.run": processResult,
      "git.root": rootResult,
      "git.status": statusResult,
      "git.diff": diffResult,
      "git.rev_parse": revParseResult,
    });
    const client = new CoreToolsDaemonClient(transport);
    const options = { signal: controller.signal, timeoutMs: 250 };

    await client.processRun({ argv: ["git", "status"], cwd: "/work" }, options);
    await client.gitRoot({ cwd: "/work" });
    await client.gitStatus({ cwd: "/work", include_untracked: true });
    await client.gitDiff({ cwd: "/work", staged: true, paths: ["a.ts"] });
    await client.gitRevParse({ cwd: "/work", revision: "HEAD" });

    expect(transport.calls).toEqual([
      {
        method: "process.run",
        params: { argv: ["git", "status"], cwd: "/work" },
        options,
      },
      { method: "git.root", params: { cwd: "/work" }, options: undefined },
      {
        method: "git.status",
        params: { cwd: "/work", include_untracked: true },
        options: undefined,
      },
      {
        method: "git.diff",
        params: { cwd: "/work", staged: true, paths: ["a.ts"] },
        options: undefined,
      },
      {
        method: "git.rev_parse",
        params: { cwd: "/work", revision: "HEAD" },
        options: undefined,
      },
    ]);
  });

  test("does not dispatch invalid params and never exposes process fallback", async () => {
    const transport = transportFor({ "process.run": processResult });
    const client = new CoreToolsDaemonClient(transport);
    await expect(
      client.processRun({ argv: ["true"], cwd: "/bad\0cwd" }),
    ).rejects.toThrow();
    expect(transport.calls).toHaveLength(0);
    expect("processRunWithFallback" in client).toBe(false);
  });

  test("preserves daemon semantic and cancellation failures", async () => {
    const semantic = new DaemonRemoteError("rejected", "GIT_FAILED");
    const semanticClient = new CoreToolsDaemonClient({
      async request() {
        throw semantic;
      },
    });
    await expect(semanticClient.gitRoot({ cwd: "/work" })).rejects.toBe(
      semantic,
    );

    const controller = new AbortController();
    controller.abort();
    const cancellationClient = new CoreToolsDaemonClient({
      async request(_method, _params, options) {
        expect(options?.signal).toBe(controller.signal);
        throw new DaemonCancelledError();
      },
    });
    await expect(
      cancellationClient.gitRoot(
        { cwd: "/work" },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(DaemonCancelledError);
  });

  test("forwards daemon timeout without converting it to a git fallback", async () => {
    let fallbackCalls = 0;
    const client = new CoreToolsDaemonClient({
      async request() {
        throw new DaemonTimeoutError("request", 5);
      },
    });
    await expect(
      client.gitDiffWithFallback({ cwd: "/work" }, () => {
        fallbackCalls += 1;
        return diffResult;
      }),
    ).rejects.toBeInstanceOf(DaemonTimeoutError);
    expect(fallbackCalls).toBe(0);
  });

  test("rejects malformed daemon responses at the boundary", async () => {
    const client = new CoreToolsDaemonClient({
      async request<T>() {
        return { root: "/work", extra: true } as unknown as T;
      },
    });
    await expect(client.gitRoot({ cwd: "/work" })).rejects.toThrow(
      "unknown field",
    );
  });

  test("accepts DaemonManager-compatible requestWithFallback transport", async () => {
    const optionsSeen: unknown[] = [];
    const client = new CoreToolsDaemonClient({
      async requestWithFallback<T>(
        _method: string,
        _params: unknown,
        fallback: T | (() => T | Promise<T>),
        options?: DaemonRequestOptions,
      ) {
        optionsSeen.push(options);
        return {
          source: "daemon",
          value: rootResult,
        } as { source: "daemon"; value: T };
      },
    });
    await expect(
      client.gitRoot({ cwd: "/work" }, { timeoutMs: 100 }),
    ).resolves.toEqual(rootResult);
    expect(optionsSeen).toEqual([{ timeoutMs: 100 }]);
  });

  test("disallows a fallback result without an explicit availability error", async () => {
    const client = new CoreToolsDaemonClient({
      async requestWithFallback<T>(
        _method: string,
        _params: unknown,
        _fallback: T | (() => T | Promise<T>),
        _options?: DaemonRequestOptions,
      ) {
        return { source: "fallback", value: {}, reason: "unavailable" } as {
          source: "fallback";
          value: T;
          reason: "unavailable";
        };
      },
    });
    await expect(
      client.gitRootWithFallback({ cwd: "/work" }, () => rootResult),
    ).rejects.toThrow(CoreToolsProtocolError);
  });
});
