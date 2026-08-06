import { describe, expect, test } from "bun:test";
import {
  DaemonClientError,
  DaemonDisabledError,
  DaemonRemoteError,
} from "../daemon/errors.js";
import { CoreToolsDaemonClient } from "./client.js";

const status = {
  root: "/repo",
  detached: false,
  staged: [],
  unstaged: [],
  untracked: [],
  conflicts: [],
};

describe("core tools read fallback", () => {
  test("runs an injected fallback once for pre-dispatch daemon unavailability", async () => {
    let calls = 0;
    const client = new CoreToolsDaemonClient({
      async request() {
        throw new DaemonDisabledError();
      },
    });
    const result = await client.gitStatusWithFallback({ cwd: "/repo" }, () => {
      calls += 1;
      return status;
    });
    expect(result.source).toBe("fallback");
    expect(result.value).toEqual(status);
    expect(calls).toBe(1);
  });

  test("allows only the manager's explicit unavailable startup error", async () => {
    let calls = 0;
    const client = new CoreToolsDaemonClient({
      async requestWithFallback<T>() {
        return {
          source: "fallback",
          value: {},
          reason: "unavailable",
          error: new DaemonClientError("DAEMON_UNAVAILABLE", "not ready"),
        } as {
          source: "fallback";
          value: T;
          reason: "unavailable";
          error: DaemonClientError;
        };
      },
    });
    await expect(
      client.gitRootWithFallback({ cwd: "/repo" }, () => {
        calls += 1;
        return { root: null };
      }),
    ).resolves.toMatchObject({ source: "fallback", value: { root: null } });
    expect(calls).toBe(1);
  });

  test("fails closed for semantic failures and ambiguous disconnects", async () => {
    let calls = 0;
    const semantic = new CoreToolsDaemonClient({
      async request() {
        throw new DaemonRemoteError("git failed", "GIT_FAILED");
      },
    });
    await expect(
      semantic.gitRootWithFallback({ cwd: "/repo" }, () => {
        calls += 1;
        return { root: null };
      }),
    ).rejects.toBeInstanceOf(DaemonRemoteError);

    const ambiguous = new CoreToolsDaemonClient({
      async requestWithFallback<T>() {
        return {
          source: "fallback",
          value: {},
          reason: "unavailable",
          error: new Error("socket closed"),
        } as {
          source: "fallback";
          value: T;
          reason: "unavailable";
          error: Error;
        };
      },
    });
    await expect(
      ambiguous.gitRootWithFallback({ cwd: "/repo" }, () => {
        calls += 1;
        return { root: null };
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(0);
  });
});
