import { describe, expect, test } from "bun:test";
import {
  DaemonCancelledError,
  DaemonDisabledError,
  DaemonRemoteError,
} from "../daemon/index.js";
import type { DaemonCallResult } from "../daemon/index.js";
import type { DaemonRequestOptions } from "../daemon/types.js";
import { SessionIndexDaemonClient } from "./client.js";
import { SessionIndexProtocolError } from "./errors.js";
import type { SessionIndexRemoteError } from "./errors.js";
import type {
  SessionIndexDaemonTransport,
  SessionIndexRecord,
} from "./protocol.js";

const session: SessionIndexRecord = {
  session_id: "session-1",
  project_path: "/work/project",
  transcript_path: "/state/session-1.jsonl",
  modified_at_ms: 1_759_478_400_000,
  size_bytes: 42,
  title: "A session",
  first_prompt: "Inspect the project",
};

function fakeTransport(
  responseByMethod: Record<string, unknown> = {},
): SessionIndexDaemonTransport & {
  calls: Array<{
    method: string;
    params: unknown;
    options?: unknown;
  }>;
} {
  const calls: Array<{
    method: string;
    params: unknown;
    options?: unknown;
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

describe("SessionIndexDaemonClient wire boundary", () => {
  test("uses exact RPC methods, params, optional fields, and request options", async () => {
    const controller = new AbortController();
    const transport = fakeTransport({
      "session_index.upsert": { session },
      "session_index.get": { session },
      "session_index.list": { sessions: [session] },
      "session_index.search": { sessions: [session] },
      "session_index.remove": { removed: true },
    });
    const client = new SessionIndexDaemonClient(transport);

    await client.upsert(session, { signal: controller.signal, timeoutMs: 500 });
    await client.get("session-1");
    await client.list({
      project_path: "/work/project",
      limit: 20,
      before_modified_at_ms: 1_759_478_400_001,
    });
    await client.search({
      query: "Inspect",
      project_path: "/work/project",
      limit: 10,
      before_modified_at_ms: 1_759_478_400_001,
    });
    await client.remove("session-1");

    expect(transport.calls).toEqual([
      {
        method: "session_index.upsert",
        params: session,
        options: { signal: controller.signal, timeoutMs: 500 },
      },
      {
        method: "session_index.get",
        params: { session_id: "session-1" },
        options: undefined,
      },
      {
        method: "session_index.list",
        params: {
          project_path: "/work/project",
          limit: 20,
          before_modified_at_ms: 1_759_478_400_001,
        },
        options: undefined,
      },
      {
        method: "session_index.search",
        params: {
          query: "Inspect",
          project_path: "/work/project",
          limit: 10,
          before_modified_at_ms: 1_759_478_400_001,
        },
        options: undefined,
      },
      {
        method: "session_index.remove",
        params: { session_id: "session-1" },
        options: undefined,
      },
    ]);
  });

  test("accepts a missing optional metadata field without fabricating nulls", async () => {
    const {
      session_id,
      project_path,
      transcript_path,
      modified_at_ms,
      size_bytes,
    } = session;
    const minimal = {
      session_id,
      project_path,
      transcript_path,
      modified_at_ms,
      size_bytes,
    };
    const transport = fakeTransport({
      "session_index.upsert": { session: minimal },
    });
    const client = new SessionIndexDaemonClient(transport);
    await expect(client.upsert(minimal)).resolves.toEqual({ session: minimal });
    expect(transport.calls[0]?.params).toEqual(minimal);
  });

  test("rejects malformed payloads with a strict protocol error", async () => {
    const malformed: Record<string, unknown>[] = [
      { session: { ...session, size_bytes: -1 } },
      { session: { ...session, title: null } },
      { sessions: [{ ...session, modified_at_ms: Number.MAX_VALUE }] },
      { removed: "true" },
      { session: session, extra: true },
    ];
    const methods = [
      "session_index.upsert",
      "session_index.get",
      "session_index.list",
      "session_index.remove",
      "session_index.upsert",
    ];
    for (const [index, payload] of malformed.entries()) {
      const transport = fakeTransport({ [methods[index] as string]: payload });
      const client = new SessionIndexDaemonClient(transport);
      const operation =
        methods[index] === "session_index.list"
          ? client.list()
          : methods[index] === "session_index.remove"
            ? client.remove("session-1")
            : methods[index] === "session_index.get"
              ? client.get("session-1")
              : client.upsert(session);
      await expect(operation).rejects.toBeInstanceOf(SessionIndexProtocolError);
    }
  });

  test("rejects unsafe request values before dispatch", async () => {
    const transport = fakeTransport({
      "session_index.get": { session: null },
      "session_index.search": { sessions: [] },
    });
    const client = new SessionIndexDaemonClient(transport);
    await expect(client.get("\0secret")).rejects.toThrow();
    await expect(client.list({ limit: 1_001 })).rejects.toThrow("0 to");
    await expect(client.search({ query: "x".repeat(4_097) })).rejects.toThrow(
      "maximum",
    );
    expect(transport.calls).toHaveLength(0);
  });

  test("preserves daemon semantic errors and does not invoke read fallback", async () => {
    let fallbackCalls = 0;
    const client = new SessionIndexDaemonClient({
      async request<T>() {
        throw new DaemonRemoteError(
          "session database rejected the request",
          "DATABASE_CLOSED",
          { retryable: false },
        );
      },
    });
    await expect(
      client.getWithFallback("session-1", () => {
        fallbackCalls += 1;
        return { session: null };
      }),
    ).rejects.toMatchObject({
      code: "DATABASE_CLOSED",
      remoteCode: "DATABASE_CLOSED",
      details: { retryable: false },
    } satisfies Partial<SessionIndexRemoteError>);
    expect(fallbackCalls).toBe(0);
  });

  test("runs read fallback once only for daemon unavailability", async () => {
    let fallbackCalls = 0;
    const client = new SessionIndexDaemonClient({
      async request<T>() {
        throw new DaemonDisabledError();
      },
    });
    const result = await client.getWithFallback("session-1", () => {
      fallbackCalls += 1;
      return { session: null };
    });
    expect(result).toMatchObject({
      source: "fallback",
      value: { session: null },
    });
    expect(fallbackCalls).toBe(1);
  });

  test("does not expose fallback callbacks for mutations", async () => {
    const client = new SessionIndexDaemonClient({
      async request<T>() {
        throw new DaemonDisabledError();
      },
    });
    await expect(client.upsert(session)).rejects.toBeInstanceOf(
      DaemonDisabledError,
    );
    await expect(client.remove("session-1")).rejects.toBeInstanceOf(
      DaemonDisabledError,
    );
  });

  test("propagates AbortSignal to requestWithFallback and preserves cancellation", async () => {
    const controller = new AbortController();
    const calls: unknown[] = [];
    const transport: SessionIndexDaemonTransport = {
      async requestWithFallback<T>(
        method: string,
        params: unknown,
        fallback: T | (() => T | Promise<T>),
        options?: DaemonRequestOptions,
      ) {
        calls.push({ method, params, options });
        if (options?.signal?.aborted) throw new DaemonCancelledError();
        const value =
          typeof fallback === "function"
            ? await (fallback as () => T | Promise<T>)()
            : fallback;
        return {
          source: "fallback",
          value,
          reason: "cancelled",
          error: new DaemonCancelledError(),
        } as DaemonCallResult<T>;
      },
    };
    const client = new SessionIndexDaemonClient(transport);
    controller.abort();
    await expect(
      client.getWithFallback("session-1", () => ({ session: null }), {
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(DaemonCancelledError);
    expect(calls).toHaveLength(1);
  });
});
