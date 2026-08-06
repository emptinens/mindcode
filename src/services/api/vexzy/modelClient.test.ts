import { describe, expect, test } from "bun:test";
import { createModelCatalogSnapshot } from "../../../runtime/modelBroker/index.js";
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

  test("serves a keyless daemon snapshot immediately and refreshes in background", async () => {
    const cachedSnapshot = createModelCatalogSnapshot(
      [model("cached-dynamic-model")],
      100,
    );
    const published: unknown[] = [];
    let releaseNetwork: (() => void) | undefined;
    let networkCalls = 0;
    const networkGate = new Promise<void>((resolve) => {
      releaseNetwork = resolve;
    });
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      now: () => 200,
      catalogCache: {
        get: async () => cachedSnapshot,
        put: async (snapshot) => {
          published.push(snapshot);
          return { stored: true };
        },
      },
      fetch: async () => {
        networkCalls += 1;
        await networkGate;
        return response(payload("fresh-dynamic-model"));
      },
    });

    const cached = await client.getModels();
    expect(cached.get("cached-dynamic-model")).toBeDefined();
    expect(
      client
        .getSnapshot()
        ?.response?.headers.get("x-mindcode-model-catalog-source"),
    ).toBe("daemon-cache");
    expect(await client.getSnapshot()?.response?.clone().text()).toBe("");
    expect(networkCalls).toBe(1);
    expect(published).toHaveLength(0);

    releaseNetwork?.();
    const fresh = await client.refresh();
    expect(fresh.get("fresh-dynamic-model")).toBeDefined();
    expect(client.getSnapshot()?.fetchedAt).toBe(200);
    expect(published).toHaveLength(1);
    expect(JSON.stringify(published[0])).not.toContain("forge-test-key");
    expect(JSON.stringify(published[0])).not.toContain("raw");
    expect(published[0]).toMatchObject({
      schema_version: 1,
      fetched_at_ms: 200,
      models: [{ id: "fresh-dynamic-model" }],
    });
  });

  test("explicit refresh bypasses the daemon snapshot and awaits VEXZY", async () => {
    const cachedSnapshot = createModelCatalogSnapshot(
      [model("cached-dynamic-model")],
      100,
    );
    let networkCalls = 0;
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      now: () => 200,
      catalogCache: {
        get: async () => cachedSnapshot,
        put: async () => ({ stored: true }),
      },
      fetch: async () => {
        networkCalls += 1;
        return response(payload("fresh-dynamic-model"));
      },
    });

    const registry = await client.getModels({ refresh: true });
    expect(registry.get("cached-dynamic-model")).toBeUndefined();
    expect(registry.get("fresh-dynamic-model")).toBeDefined();
    expect(networkCalls).toBe(1);
  });

  test("keeps live catalog timestamps monotonic across clock rollback", async () => {
    const timestamps = [200, 100];
    const published: number[] = [];
    let call = 0;
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      now: () => timestamps.shift() ?? 0,
      catalogCache: {
        get: async () => null,
        put: async (catalog) => {
          published.push(catalog.fetched_at_ms);
          return { stored: true };
        },
      },
      fetch: async () => {
        call += 1;
        return response(payload(`model-${call}`));
      },
    });

    await client.getModels();
    await client.refresh();
    await Promise.resolve();

    expect(client.getSnapshot()?.fetchedAt).toBe(201);
    expect(published).toEqual([200, 201]);
  });

  test("falls through to VEXZY when the daemon cache is unavailable", async () => {
    let calls = 0;
    const client = createVexzyModelClient({
      apiKey: "forge-test-key",
      catalogCache: {
        get: async () => {
          throw new Error("daemon unavailable");
        },
        put: async () => ({ stored: true }),
      },
      fetch: async () => {
        calls += 1;
        return response(payload("network-authoritative-model"));
      },
    });

    const registry = await client.getModels();
    expect(registry.get("network-authoritative-model")).toBeDefined();
    expect(calls).toBe(1);
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
