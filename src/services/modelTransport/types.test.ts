import { describe, expect, test } from "bun:test";
import type { ModelTransport, TransportRequest } from "./index.js";
import { ModelTransportError } from "./index.js";

describe("provider-neutral model transport contracts", () => {
  test("represent a request without provider protocol names", () => {
    const request: TransportRequest = {
      model: "gpt-5.6-luna",
      maxOutputTokens: 128,
      messages: [{ role: "user", content: "hello" }],
      reasoningEffort: "medium",
      outputFormat: { type: "json" },
    };

    expect(request.maxOutputTokens).toBe(128);
    expect(request.reasoningEffort).toBe("medium");
  });

  test("keeps the public transport surface structural and bounded", () => {
    const methods: readonly (keyof ModelTransport)[] = [
      "complete",
      "stream",
      "countInputTokens",
      "listModels",
    ];
    expect(methods).toHaveLength(4);
  });

  test("exposes normalized transport errors", () => {
    const error = new ModelTransportError("timeout", 504);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("timeout");
    expect(error.status).toBe(504);
    expect(error.message).toBe("Model transport request timeout");
  });
});
