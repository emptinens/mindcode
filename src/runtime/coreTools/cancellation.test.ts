import { describe, expect, test } from "bun:test";
import { DaemonCancelledError } from "../daemon/errors.js";
import { CoreToolsDaemonClient } from "./client.js";

describe("core tools cancellation", () => {
  test("forwards AbortSignal and timeout options to DaemonManager transport", async () => {
    const controller = new AbortController();
    const seen: unknown[] = [];
    const client = new CoreToolsDaemonClient({
      async request<T>(
        _method: string,
        _params: unknown,
        options?: import("../daemon/types.js").DaemonRequestOptions,
      ) {
        seen.push(options);
        if (options?.signal?.aborted) throw new DaemonCancelledError();
        return { root: "/repo" } as T;
      },
    });

    await expect(
      client.gitRoot(
        { cwd: "/repo" },
        { signal: controller.signal, timeoutMs: 123 },
      ),
    ).resolves.toEqual({ root: "/repo" });
    controller.abort();
    await expect(
      client.gitRoot(
        { cwd: "/repo" },
        { signal: controller.signal, timeoutMs: 123 },
      ),
    ).rejects.toBeInstanceOf(DaemonCancelledError);
    expect(seen).toEqual([
      { signal: controller.signal, timeoutMs: 123 },
      { signal: controller.signal, timeoutMs: 123 },
    ]);
  });

  test("never falls back after cancellation", async () => {
    let fallbackCalls = 0;
    const controller = new AbortController();
    controller.abort();
    const client = new CoreToolsDaemonClient({
      async request() {
        throw new DaemonCancelledError();
      },
    });
    await expect(
      client.gitDiffWithFallback(
        { cwd: "/repo" },
        () => {
          fallbackCalls += 1;
          return { root: "/repo", patch: "", truncated: false };
        },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(DaemonCancelledError);
    expect(fallbackCalls).toBe(0);
  });
});
