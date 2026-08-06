import { describe, expect, test } from "bun:test";

import {
  VexzyRequestSnapshotError,
  createVexzyRequestSnapshot,
  digestVexzyRequestParams,
} from "./requestSnapshot.js";
import type { VexzyRequestSnapshotParams } from "./requestSnapshot.js";

function request(): VexzyRequestSnapshotParams {
  return {
    model: "gpt-5.6-luna",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "preserve this" },
          {
            type: "image",
            source: { type: "url", url: "https://example.test/image.png" },
          },
        ],
      },
    ],
    tools: [
      {
        name: "lookup",
        input_schema: {
          type: "object",
          properties: { query: { type: "string" } },
        },
      },
    ],
    metadata: { optional: undefined },
  };
}

describe("VEXZY request snapshots", () => {
  test("defensively clones and freezes caller data while preserving undefined", () => {
    const input = request();
    const snapshot = createVexzyRequestSnapshot(input);

    (input as unknown as { messages: unknown[] }).messages = [];
    (input.metadata as Record<string, unknown>).optional = "changed";

    expect(snapshot.params.messages).toHaveLength(1);
    expect(snapshot.params.metadata).toHaveProperty("optional", undefined);
    expect(Object.isFrozen(snapshot.params)).toBe(true);
    expect(Object.isFrozen(snapshot.params.messages)).toBe(true);
    expect(Object.isFrozen(snapshot.params.messages[0])).toBe(true);
  });

  test("materializes independent mutable clones for every dispatch", () => {
    const snapshot = createVexzyRequestSnapshot(request());
    const first = snapshot.materialize();
    const second = snapshot.materialize();

    expect(first).not.toBe(second);
    expect(first.messages).not.toBe(second.messages);
    const firstMessage = first.messages[0];
    const secondMessage = second.messages[0];
    if (!firstMessage || !secondMessage) throw new Error("expected messages");
    const firstContent = firstMessage.content as Record<string, unknown>[];
    const secondContent = secondMessage.content as Record<string, unknown>[];
    const firstBlock = firstContent[0];
    const secondBlock = secondContent[0];
    if (!firstBlock || !secondBlock) throw new Error("expected content blocks");
    firstBlock.text = "one";
    (first.metadata as Record<string, unknown>).optional = "one";

    expect(secondBlock.text).toBe("preserve this");
    expect(second.metadata).toHaveProperty("optional", undefined);
  });

  test("rejects cycles, custom prototypes, and accessors without invoking getters", () => {
    const cyclic = request();
    (cyclic as unknown as Record<string, unknown>).self = cyclic;
    expectSnapshotError(() => createVexzyRequestSnapshot(cyclic), "cycle");

    const custom = Object.create({
      inherited: true,
    }) as VexzyRequestSnapshotParams;
    Object.assign(custom, request());
    expectSnapshotError(() => createVexzyRequestSnapshot(custom), "prototype");

    let invoked = false;
    const accessor = request();
    Object.defineProperty(accessor, "lazy", {
      enumerable: true,
      get: () => {
        invoked = true;
        return "secret";
      },
    });
    expectSnapshotError(() => createVexzyRequestSnapshot(accessor), "accessor");
    expect(invoked).toBe(false);
  });

  test("rejects depth, node, and byte limit violations", () => {
    expectSnapshotError(
      () => createVexzyRequestSnapshot(request(), { maxDepth: 1 }),
      "max_depth",
    );
    expectSnapshotError(
      () => createVexzyRequestSnapshot(request(), { maxNodes: 3 }),
      "max_nodes",
    );
    expectSnapshotError(
      () =>
        createVexzyRequestSnapshot(
          { ...request(), large: "123456789" },
          { maxBytes: 8 },
        ),
      "max_bytes",
    );
  });

  test("rejects credential-shaped fields, including nested headers", () => {
    for (const value of [
      { ...request(), apiKey: "forge-secret" },
      { ...request(), "x-api-key": "forge-secret" },
      { ...request(), Authorization: "Bearer secret" },
      { ...request(), headers: { Authorization: "Bearer secret" } },
    ]) {
      expectSnapshotError(
        () => createVexzyRequestSnapshot(value),
        "credential_field",
      );
    }
  });

  test("preserves credential-shaped keys inside user message and tool JSON", () => {
    const input = {
      ...request(),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "api_key is prompt data" }],
        },
      ],
      tools: [
        { input_schema: { properties: { api_key: { type: "string" } } } },
      ],
    } as VexzyRequestSnapshotParams;
    const snapshot = createVexzyRequestSnapshot(input);
    const materialized = snapshot.materialize() as Record<string, unknown>;
    const tool = (materialized.tools as Record<string, unknown>[])[0];
    if (!tool) throw new Error("expected materialized tool");

    expect(tool.input_schema).toEqual({
      properties: { api_key: { type: "string" } },
    });
  });

  test("rejects non-object request roots", () => {
    expectSnapshotError(
      () => createVexzyRequestSnapshot([] as never),
      "invalid_root",
    );
    expectSnapshotError(
      () => createVexzyRequestSnapshot(null as never),
      "invalid_root",
    );
  });

  test("produces a deterministic digest independent of insertion order", () => {
    const first = createVexzyRequestSnapshot({
      ...request(),
      metadata: { z: 1, a: undefined },
    });
    const second = createVexzyRequestSnapshot({
      ...request(),
      metadata: { a: undefined, z: 1 },
    });

    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.digest).toBe(second.digest);
    expect(digestVexzyRequestParams(request())).toBe(
      createVexzyRequestSnapshot(request()).digest,
    );
  });
});

function expectSnapshotError(
  action: () => unknown,
  code: VexzyRequestSnapshotError["code"],
): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(VexzyRequestSnapshotError);
    expect((error as VexzyRequestSnapshotError).code).toBe(code);
  }
}
