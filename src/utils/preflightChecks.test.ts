import { describe, expect, mock, test } from "bun:test";
import { VEXZY_OPENAI_ENDPOINTS } from "../services/api/vexzy/config.js";

mock.module("../ink.js", () => ({
  Box: "Box",
  Text: "Text",
}));
mock.module("../components/Spinner.js", () => ({ Spinner: "Spinner" }));
mock.module("../hooks/useTimeout.js", () => ({ useTimeout: () => false }));

const { checkVexzyConnection } = await import("./preflightChecks.js");
type VexzyFetchOptions = Parameters<typeof checkVexzyConnection>[0];

function options(
  response: Response | Promise<Response>,
  overrides: Partial<VexzyFetchOptions> = {},
): VexzyFetchOptions {
  return {
    apiKey: "forge-test-key",
    fetchImpl: async (...args) => {
      expect(args[0]).toBe(VEXZY_OPENAI_ENDPOINTS.models);
      return response;
    },
    ...overrides,
  };
}

describe("checkVexzyConnection", () => {
  test("checks only the VEXZY models endpoint with a bearer key", async () => {
    let request: RequestInit | undefined;
    const result = await checkVexzyConnection({
      apiKey: "forge-secret-key",
      fetchImpl: async (_url, init) => {
        request = init;
        return new Response("{}", { status: 200 });
      },
    });

    expect(result).toEqual({ success: true });
    expect(request?.method).toBe("GET");
    expect(request?.headers).toEqual({
      Authorization: "Bearer forge-secret-key",
      Accept: "application/json",
    });
  });

  test("reports VEXZY authentication failures without leaking the key", async () => {
    const result = await checkVexzyConnection(
      options(new Response("", { status: 401 }), {
        apiKey: "forge-secret-key",
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("VEXZY API authentication failed");
    expect(result.error).not.toContain("forge-secret-key");
  });

  test("reports other HTTP failures as VEXZY errors", async () => {
    const result = await checkVexzyConnection(
      options(new Response("", { status: 503 })),
    );

    expect(result).toEqual({
      success: false,
      error: "VEXZY API request failed (HTTP 503)",
    });
  });

  test("does not request without an API key", async () => {
    let called = false;
    const result = await checkVexzyConnection({
      apiKey: "",
      fetchImpl: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
    });

    expect(called).toBe(false);
    expect(result).toEqual({
      success: false,
      error: "VEXZY_API_KEY is not configured",
    });
  });

  test("aborts slow requests at the configured timeout", async () => {
    const result = await checkVexzyConnection({
      apiKey: "forge-timeout-key",
      timeoutMs: 1,
      fetchImpl: async (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        }),
    });

    expect(result).toEqual({
      success: false,
      error: "VEXZY API request timed out after 1ms",
    });
  });
});
