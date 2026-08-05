import { describe, expect, test } from "bun:test";
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "./errors.js";
import {
  type VexzySDKMessageParams,
  createVexzySDKAdapter,
  estimateVexzyInputTokens,
} from "./sdkAdapter.js";

const message = () => ({
  type: "message",
  id: "msg_adapter",
  role: "assistant",
  model: "gpt-5.6-luna",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 2, output_tokens: 1 },
});

const params: VexzySDKMessageParams = {
  model: "gpt-5.6-luna",
  max_tokens: 16,
  messages: [{ role: "user", content: "hello" }],
};

const jsonResponse = (body: unknown, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

const streamResponse = () =>
  new Response(
    [
      {
        type: "message_start",
        message: message(),
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 1 },
      },
      { type: "message_stop" },
    ]
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "request-id": "stream_1",
      },
    },
  );

describe("Vexzy SDK compatibility adapter", () => {
  test("sends explicit Luna worker none effort as reasoning_effort none", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(message());
      },
    });

    await adapter.messages.create({
      ...params,
      output_config: { effort: "none" },
    });

    expect(seenBody?.model).toBe("gpt-5.6-luna");
    expect(seenBody?.reasoning_effort).toBe("none");
    expect(seenBody).not.toHaveProperty("output_config");
  });

  test("preserves create, withResponse, asResponse, and per-request headers", async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: Record<string, unknown> | undefined;
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        seenHeaders = new Headers(init?.headers);
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse(message(), {
          "request-id": "request_1",
          "x-quota": "42",
        });
      },
    });

    const request = adapter.beta.messages.create(
      {
        ...params,
        output_config: { effort: "max", format: { type: "json_schema" } },
      },
      { headers: { "x-client-request": "one" } },
    );
    const result = await request.withResponse();
    const raw = await request.asResponse();

    expect(result.data).toMatchObject({ id: "msg_adapter" });
    expect(result.response.status).toBe(200);
    expect(result.request_id).toBe("request_1");
    expect(raw.headers.get("x-quota")).toBe("42");
    await expect(raw.json()).resolves.toMatchObject({ id: "msg_adapter" });
    expect(seenHeaders?.get("x-client-request")).toBe("one");
    expect(seenHeaders?.get("authorization")).toBe("Bearer forge-test-key");
    expect(seenBody?.reasoning_effort).toBe("max");
    expect(seenBody?.output_config).toEqual({
      format: { type: "json_schema" },
    });
  });

  test("preserves a raw response body when the provider omits request-id", async () => {
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async () => jsonResponse(message(), { "x-quota": "7" }),
    });

    const raw = await adapter.messages.create(params).asResponse();

    expect(raw.headers.get("x-quota")).toBe("7");
    await expect(raw.json()).resolves.toMatchObject({ id: "msg_adapter" });
  });

  test("propagates the configured retry budget to native Messages", async () => {
    let calls = 0;
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      maxRetries: 0,
      fetch: async () => {
        calls += 1;
        return new Response(null, { status: 503 });
      },
    });

    await expect(adapter.messages.create(params)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toBe(1);
  });

  test("normalizes native abort and timeout failures to SDK-compatible types", async () => {
    const abortController = new AbortController();
    const abortedAdapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("transport detail");
      },
    });
    const aborted = abortedAdapter.messages.create(params, {
      signal: abortController.signal,
    });
    abortController.abort();
    await expect(aborted).rejects.toBeInstanceOf(APIUserAbortError);
    await expect(aborted).rejects.toBeInstanceOf(APIError);

    const timeoutAdapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("timeout detail");
      },
    });
    await expect(timeoutAdapter.messages.create(params)).rejects.toBeInstanceOf(
      APIConnectionTimeoutError,
    );
  });

  test("exposes a cancellable async stream and response metadata", async () => {
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async () => streamResponse(),
    });
    const streamRequest = adapter.messages.create({ ...params, stream: true });
    const result = await streamRequest.withResponse();
    const events: string[] = [];
    for await (const event of result.data as AsyncIterable<{ type: string }>) {
      events.push(event.type);
    }

    expect(events).toContain("message_start");
    expect(result.request_id).toBe("stream_1");
    expect(result.data.controller).toBeInstanceOf(AbortController);
    result.data.abort();
    expect(result.data.aborted).toBe(true);
  });

  test("estimates countTokens locally without an undocumented endpoint", async () => {
    let fetchCalls = 0;
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async () => {
        fetchCalls += 1;
        throw new Error("countTokens must not use the network");
      },
    });
    const input = {
      model: params.model,
      messages: params.messages,
    };
    const result = await adapter.beta.messages.countTokens(input).withResponse();

    expect(fetchCalls).toBe(0);
    expect(result.data.input_tokens).toBe(estimateVexzyInputTokens(input));
    expect(result.request_id).toBeUndefined();
    expect(result.response.status).toBe(200);
    expect(result.response.headers.get("x-mindcode-token-count-source")).toBe(
      "local-estimate",
    );
  });

  test("maps the dynamic model registry to an async SDK-style list", async () => {
    const adapter = createVexzySDKAdapter({
      apiKey: "forge-test-key",
      fetch: async () =>
        jsonResponse({
          object: "list",
          data: [
            {
              id: "gpt-5.6-luna",
              object: "model",
              owned_by: "vexzy",
              display_name: "GPT-5.6 Luna",
              available: true,
              context_length: 1_050_000,
              supported_reasoning_efforts: ["none", "max"],
              input_modalities: ["text"],
              output_modalities: ["text"],
              capabilities: { reasoning: true, tools: true, vision: false },
            },
          ],
        }, { "request-id": "models_1" }),
    });
    const result = await adapter.models.list().withResponse();
    const page = result.data;
    const entries: string[] = [];
    for await (const entry of page) entries.push(entry.id);

    expect(entries).toEqual(["gpt-5.6-luna"]);
    expect(page.data[0]?.display_name).toBe("GPT-5.6 Luna");
    expect(page.data[0]?.created_at).toBeUndefined();
    expect(result.request_id).toBe("models_1");
    expect(result.response.status).toBe(200);
    expect(await result.response.clone().json()).toMatchObject({
      object: "list",
    });
  });
});
