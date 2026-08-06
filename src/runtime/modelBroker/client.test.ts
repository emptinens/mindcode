import { describe, expect, test } from "bun:test";
import {
  DaemonClientError,
  DaemonDisabledError,
  DaemonRemoteError,
} from "../daemon/index.js";
import type { DaemonCallResult } from "../daemon/index.js";
import { ModelCatalogDaemonClient } from "./client.js";
import type {
  ModelCatalogDaemonTransport,
  ModelCatalogSnapshot,
  ModelCatalogStatusResult,
} from "./types.js";
import {
  ModelCatalogProtocolError,
  createNormalizedModelCatalogSnapshot,
  normalizeModelCatalogSnapshot,
  validateModelCatalogSnapshot,
} from "./validation.js";

const snapshot: ModelCatalogSnapshot = createNormalizedModelCatalogSnapshot(
  [
    {
      id: "gpt-5.6-luna",
      display_name: "GPT-5.6 Luna",
      available: true,
      status: "working",
      context_length: 1_100_000,
      efforts: ["none", "low", "medium", "high", "xhigh", "max"],
      modalities: { input: ["text", "image"], output: ["text"] },
      capabilities: { reasoning: true, tools: true, vision: true },
      output_limit: 131_072,
      output_credits_per_million: 37,
    },
  ],
  1_759_478_400_000,
);

function transport(
  responses: Record<string, unknown>,
): ModelCatalogDaemonTransport & {
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  return {
    calls,
    async request<T>(method: string, params: unknown) {
      calls.push({ method, params });
      return responses[method] as T;
    },
  };
}

describe("keyless model catalog boundary", () => {
  test("normalizes provider metadata and drops unsafe fields", () => {
    const firstModel = snapshot.models[0];
    if (!firstModel) throw new Error("expected fixture model");
    const result = normalizeModelCatalogSnapshot({
      ...snapshot,
      models: [
        {
          ...firstModel,
          raw: { api_key: "forge-secret", prompts: ["private"] },
          Authorization: "Bearer secret",
          response: "private",
          supported_reasoning_efforts: ["low", "low", "high"],
        },
      ],
    });
    const normalizedModel = result.models[0];
    if (!normalizedModel) throw new Error("expected normalized model");
    expect(normalizedModel).not.toHaveProperty("raw");
    expect(normalizedModel).not.toHaveProperty("Authorization");
    expect(normalizedModel.efforts).toEqual([
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(JSON.stringify(result)).not.toContain("forge-secret");
  });

  test("rejects schema violations and forbidden nested fields", () => {
    expect(() =>
      validateModelCatalogSnapshot({ ...snapshot, schema_version: 2 }),
    ).toThrow(ModelCatalogProtocolError);
    expect(() =>
      validateModelCatalogSnapshot({ ...snapshot, key: "secret" }),
    ).toThrow(ModelCatalogProtocolError);
    expect(() =>
      validateModelCatalogSnapshot({
        ...snapshot,
        models: [
          { ...snapshot.models[0], capabilities: { Authorization: true } },
        ],
      }),
    ).toThrow(ModelCatalogProtocolError);
    expect(() =>
      validateModelCatalogSnapshot({
        ...snapshot,
        models: [{ ...snapshot.models[0], context_length: Number.MAX_VALUE }],
      }),
    ).toThrow(ModelCatalogProtocolError);
    expect(() =>
      createNormalizedModelCatalogSnapshot([], Number.MAX_SAFE_INTEGER),
    ).toThrow(/future/);
  });

  test("uses exact RPC methods and sends only keyless normalized data", async () => {
    const daemon = transport({
      "vexzy.catalog.get": { snapshot },
      "vexzy.catalog.put": { stored: true },
      "vexzy.catalog.status": {
        state: "ready",
        has_snapshot: true,
        fetched_at_ms: snapshot.fetched_at_ms,
        digest: snapshot.digest,
      },
    });
    const client = new ModelCatalogDaemonClient(daemon);
    await client.get();
    await client.put({
      ...snapshot,
      models: [{ ...snapshot.models[0], raw: "must not cross" }],
    } as unknown as ModelCatalogSnapshot);
    await client.status();
    expect(daemon.calls.map((call) => call.method)).toEqual([
      "vexzy.catalog.get",
      "vexzy.catalog.put",
      "vexzy.catalog.status",
    ]);
    expect(daemon.calls[0]?.params).toEqual({});
    expect(daemon.calls[2]?.params).toEqual({});
    const putParams = daemon.calls[1]?.params as {
      snapshot: ModelCatalogSnapshot;
    };
    expect(putParams.snapshot.models[0]).not.toHaveProperty("raw");
    expect(JSON.stringify(daemon.calls)).not.toMatch(
      /key|authorization|prompt|response/i,
    );
  });

  test("deep-freezes daemon snapshots and local cache", async () => {
    const daemon = transport({ "vexzy.catalog.get": { snapshot } });
    const client = new ModelCatalogDaemonClient(daemon);
    const result = await client.get();
    expect(result).toBe(client.getSnapshot() as ModelCatalogSnapshot | null);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.models)).toBe(true);
    expect(Object.isFrozen(result?.models[0])).toBe(true);
    expect(() => {
      (result as { digest: string }).digest = "changed";
    }).toThrow();
  });

  test("falls back only for daemon availability and keeps daemon authority", async () => {
    const unavailable: ModelCatalogDaemonTransport = {
      async request<T>() {
        throw new DaemonDisabledError();
      },
    };
    const fallbackClient = new ModelCatalogDaemonClient(unavailable);
    const fallback = await fallbackClient.getWithFallback(() => snapshot);
    expect(fallback.source).toBe("fallback");
    expect(fallback.value).toEqual(snapshot);
    expect(fallbackClient.getSnapshot() as ModelCatalogSnapshot | null).toEqual(
      snapshot,
    );

    const remoteFailure: ModelCatalogDaemonTransport = {
      async request<T>() {
        throw new DaemonRemoteError("denied");
      },
    };
    const strictClient = new ModelCatalogDaemonClient(remoteFailure);
    await expect(
      strictClient.getWithFallback(() => snapshot),
    ).rejects.toBeInstanceOf(DaemonRemoteError);

    const authoritative = transport({ "vexzy.catalog.get": { snapshot } });
    const authorityClient = new ModelCatalogDaemonClient(authoritative);
    const daemonResult = await authorityClient.getWithFallback(() => null);
    expect(daemonResult.source).toBe("daemon");
    expect(daemonResult.value).toEqual(snapshot);
  });

  test("factory accepts registry-shaped models and creates deterministic SHA-256", () => {
    const input = {
      id: "future-model",
      displayName: "Future",
      available: true,
      contextLength: 2_048,
      supportedReasoningEfforts: ["medium"],
      inputModalities: ["text"],
      outputModalities: ["text"],
      reasoning: true,
      tools: false,
      vision: false,
      outputLimit: 1_024,
      outputCreditsPerMillion: 12,
      provider_private_field: "drop",
    };
    const first = createNormalizedModelCatalogSnapshot([input], 42);
    const second = createNormalizedModelCatalogSnapshot([input], 42);
    expect(first).toEqual(second);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
    const reordered = createNormalizedModelCatalogSnapshot(
      [
        {
          ...input,
          capabilities: { vision: false, tools: false, reasoning: true },
        },
      ],
      42,
    );
    expect(reordered.digest).toBe(first.digest);
    expect(first.models[0]).not.toHaveProperty("provider_private_field");
  });

  test("enforces model count, duplicate IDs, output limit, and 1 MiB bounds", () => {
    const firstModel = snapshot.models[0];
    if (!firstModel) throw new Error("expected fixture model");
    expect(() =>
      createNormalizedModelCatalogSnapshot(
        [firstModel, firstModel],
        42,
      ),
    ).toThrow(/duplicate model id/);
    expect(() =>
      createNormalizedModelCatalogSnapshot(
        [
          {
            ...firstModel,
            output_limit: firstModel.context_length + 1,
          },
        ],
        42,
      ),
    ).toThrow(/output_limit/);
    expect(() =>
      createNormalizedModelCatalogSnapshot(
        Array.from({ length: 1_025 }, (_, index) => ({
          ...firstModel,
          id: `model-${index}`,
        })),
        42,
      ),
    ).toThrow(/1024/);
    expect(() =>
      createNormalizedModelCatalogSnapshot(
        Array.from({ length: 1_024 }, (_, index) => ({
          ...snapshot.models[0],
          id: `${"i".repeat(250)}${String(index).padStart(6, "0")}`,
          display_name: "d".repeat(512),
          status: "s".repeat(128),
          efforts: ["e".repeat(128)],
          modalities: { input: ["i".repeat(128)], output: ["o".repeat(128)] },
        })),
        42,
      ),
    ).toThrow(/1 MiB/);
  });

  test("requires complete ready status and empty status metadata", async () => {
    const daemon = transport({
      "vexzy.catalog.status": { state: "ready", has_snapshot: true },
    });
    await expect(
      new ModelCatalogDaemonClient(daemon).status(),
    ).rejects.toBeInstanceOf(ModelCatalogProtocolError);
    const emptyDaemon = transport({
      "vexzy.catalog.status": {
        state: "empty",
        has_snapshot: false,
        digest: snapshot.digest,
      },
    });
    await expect(
      new ModelCatalogDaemonClient(emptyDaemon).status(),
    ).rejects.toBeInstanceOf(ModelCatalogProtocolError);
  });

  test("does not treat invalid daemon data as a fallback condition", async () => {
    const daemon = transport({
      "vexzy.catalog.get": { snapshot: { ...snapshot, digest: 3 } },
    });
    const client = new ModelCatalogDaemonClient(daemon);
    await expect(client.getWithFallback(() => snapshot)).rejects.toBeInstanceOf(
      ModelCatalogProtocolError,
    );
  });
});
