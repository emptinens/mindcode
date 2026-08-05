import { describe, expect, test } from "bun:test";
import { createVexzyModelClient } from "./modelClient.js";
import { VexzyError } from "./errors.js";

const model = (id: string) => ({
  id,
  object: "model" as const,
  owned_by: "vexzy" as const,
  display_name: id,
  available: true,
  context_length: 100_000,
  supported_reasoning_efforts: ["none"],
  input_modalities: ["text"],
  output_modalities: ["text"],
  capabilities: { reasoning: false, tools: true, vision: false },
});

const payload = (...ids: string[]) => ({
  object: "list" as const,
  data: ids.map(model),
});

const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

describe("Vexzy model client", () => {
  test("fetches the dynamic model registry with the configured Bearer token", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      fetch: async (input, init) => {
        calls.push({ input, init });
        return response(payload("vendor-dynamic-model"), 200, {
          "request-id": "models-live-1",
        });
      },
      now: () => 123,
    });

    const registry = await client.getModels();
    const init = calls[0]?.init;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe("https://api.echogate.one/v1/models");
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer forge-test-key",
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(registry.get("vendor-dynamic-model")?.id).toBe(
      "vendor-dynamic-model",
    );
    expect(client.getSnapshot()?.fetchedAt).toBe(123);
    expect(client.getSnapshot()?.response?.status).toBe(200);
    expect(client.getSnapshot()?.response?.headers.get("request-id")).toBe(
      "models-live-1",
    );
    expect(await client.getSnapshot()?.response?.clone().json()).toEqual(
      payload("vendor-dynamic-model"),
    );
  });

  test("uses the last successful snapshot for exhausted 429 responses", async () => {
    const calls: number[] = [];
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        calls.push(1);
        return calls.length === 1
          ? response(payload("first-dynamic-model"))
          : response("secret response body", 429, { "retry-after": "0" });
      },
      sleep: async () => {},
    });

    const first = await client.getModels();
    const refreshed = await client.refresh();

    expect(refreshed).toBe(first);
    expect(refreshed.get("first-dynamic-model")).toBeDefined();
    expect(calls).toHaveLength(5);
  });

  test("refresh explicitly replaces the cached snapshot without model constants", async () => {
    let call = 0;
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        call += 1;
        return response(
          payload(call === 1 ? "first-dynamic-model" : "second-dynamic-model"),
        );
      },
    });

    const first = await client.getModels();
    const cached = await client.getModels();
    const second = await client.refresh();

    expect(cached).toBe(first);
    expect(second).not.toBe(first);
    expect(second.get("first-dynamic-model")).toBeUndefined();
    expect(second.get("second-dynamic-model")).toBeDefined();
  });

  test("does not expose an error body or API key for HTTP failures", async () => {
    const client = createVexzyModelClient({
      apiKey: "forge-secret-key",
      fetch: async () => response("body-for-server-only", 429),
      sleep: async () => {},
    });

    let thrown: unknown;
    try {
      await client.getModels();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(VexzyError);
    expect(String(thrown)).not.toContain("body-for-server-only");
    expect(String(thrown)).not.toContain("forge-secret-key");
  });

  test("uses a safe error for invalid JSON and invalid registry payloads", async () => {
    const invalidJsonClient = createVexzyModelClient({
      apiKey: "forge-secret-key",
      fetch: async () =>
        new Response("contains-forge-secret-key", { status: 200 }),
    });
    const invalidPayloadClient = createVexzyModelClient({
      apiKey: "forge-secret-key",
      fetch: async () =>
        response({ object: "list", data: ["contains-secret"] }),
    });

    await expect(invalidJsonClient.getModels()).rejects.toMatchObject({
      name: "VexzyModelClientError",
      code: "invalid_response",
    });
    await expect(invalidPayloadClient.getModels()).rejects.toMatchObject({
      name: "VexzyModelClientError",
      code: "invalid_response",
    });
  });

  test("honors a caller AbortSignal and a request timeout", async () => {
    const callerController = new AbortController();
    const abortedClient = createVexzyModelClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("aborted");
      },
    });
    const aborted = abortedClient.getModels({
      signal: callerController.signal,
    });
    callerController.abort();
    await expect(aborted).rejects.toMatchObject({
      name: "VexzyModelClientError",
      code: "aborted",
    });

    const timeoutClient = createVexzyModelClient({
      apiKey: "forge-test-key",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) => {
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        throw new Error("timed out");
      },
    });

    await expect(timeoutClient.getModels()).rejects.toEqual(
      expect.objectContaining({
        name: "VexzyModelClientError",
        code: "timeout",
      }),
    );
  });
});
