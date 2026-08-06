import { describe, expect, test } from "bun:test";
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  VexzyClient,
} from "./protocolTypes.js";
import { APIError } from "./errors.js";
import type {
  VexzySDKClient,
  VexzySDKMessageParams,
  VexzySDKResponse,
  VexzySDKStream,
} from "./sdkAdapter.js";
import {
  completeRuntimeRequest,
  countRuntimeInputTokens,
  streamRuntimeRequest,
  toTransportRequest,
} from "./modelRuntimeTransport.js";

const params: BetaMessageStreamParams = {
  model: "gpt-5.6-luna",
  max_tokens: 128,
  messages: [{ role: "user", content: "hello" }],
  system: [{ type: "text", text: "system" }],
  tools: [
    {
      type: "custom",
      name: "lookup",
      description: "Look up a value",
      input_schema: { type: "object" },
      defer_loading: true,
    },
  ],
  tool_choice: { type: "none" },
  thinking: { type: "adaptive" },
  output_config: { effort: "high", task_budget: { type: "tokens", total: 10 } },
  betas: ["runtime-test"],
  speed: "fast",
};

const message: BetaMessage = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  model: "gpt-5.6-luna",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: {
    input_tokens: 4,
    output_tokens: 2,
    cache_read_input_tokens: 1,
    server_tool_use: { web_search_requests: 1 },
  },
};

function sdkPromise<T>(
  value: T,
  response = new Response(null, { status: 200 }),
  requestId = "req_1",
): VexzySDKPromise<T> {
  const pending = Promise.resolve(value) as VexzySDKPromise<T>;
  const settled: Promise<VexzySDKResponse<T>> = Promise.resolve({
    data: value,
    response,
    request_id: requestId,
  });
  pending.withResponse = async () => settled;
  pending.asResponse = async () => response;
  return pending;
}

function clientFor(
  create: VexzySDKClient["messages"]["create"],
  countTokens: VexzySDKClient["messages"]["countTokens"] = () =>
    sdkPromise({ input_tokens: 9 }),
): VexzyClient {
  const messages = {
    create,
    stream: () => {
      throw new Error("stream helper is not used");
    },
    countTokens,
  };
  return {
    messages,
    beta: { messages },
  } as unknown as VexzyClient;
}

describe("modelRuntime ModelTransport compatibility bridge", () => {
  test("maps runtime protocol fields into neutral fields without dropping extensions", () => {
    const request = toTransportRequest(params);

    expect(request).toMatchObject({
      model: "gpt-5.6-luna",
      maxOutputTokens: 128,
      toolChoice: { kind: "none" },
      extensions: {
        thinking: { type: "adaptive" },
        output_config: {
          effort: "high",
          task_budget: { type: "tokens", total: 10 },
        },
        betas: ["runtime-test"],
        speed: "fast",
      },
      tools: [
        {
          name: "lookup",
          extensions: { type: "custom", defer_loading: true },
        },
      ],
    });
  });

  test("routes complete and count calls through the neutral transport", async () => {
    let seen: VexzySDKMessageParams | undefined;
    const client = clientFor((request) => {
      seen = request;
      return sdkPromise(message);
    });

    const result = await completeRuntimeRequest(client, params);
    expect(seen).toMatchObject({
      model: "gpt-5.6-luna",
      max_tokens: 128,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tool_choice: { type: "none" },
    });
    expect(result.data.usage).toMatchObject({
      input_tokens: 4,
      output_tokens: 2,
      cache_read_input_tokens: 1,
      server_tool_use: { web_search_requests: 1 },
    });
    await expect(countRuntimeInputTokens(client, params)).resolves.toBe(9);
  });

  test("preserves raw stream lifecycle, stop events, and abort wiring", async () => {
    const source: VexzySDKStream = {
      controller: new AbortController(),
      response: Promise.resolve(new Response(null, { status: 200 })),
      request_id: Promise.resolve("stream_1"),
      aborted: false,
      abort() {
        this.controller.abort();
      },
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message_start",
          message,
        } as BetaRawMessageStreamEvent;
        yield { type: "message_stop" } as BetaRawMessageStreamEvent;
      },
    };
    const stream = await streamRuntimeRequest(
      clientFor(() => sdkPromise(source, undefined, "stream_1")),
      params,
    );
    const events: BetaRawMessageStreamEvent[] = [];
    for await (const event of stream.data) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "message_stop",
    ]);
    expect(events[0]).toMatchObject({
      type: "message_start",
      message: { usage: { cache_read_input_tokens: 1 } },
    });
    await expect(stream.data.request_id).resolves.toBe("stream_1");
  });

  test("restores retry-visible VEXZY API errors at the runtime boundary", async () => {
    const error = new APIError(
      429,
      { type: "rate_limit_error" },
      "rate limited",
      new Headers({ "retry-after": "1" }),
    );
    const failed = Promise.resolve(message) as VexzySDKPromise<BetaMessage>;
    failed.withResponse = async () => Promise.reject(error);
    failed.asResponse = async () => Promise.reject(error);

    await expect(
      completeRuntimeRequest(
        clientFor(() => failed),
        params,
      ),
    ).rejects.toBe(error);
  });
});
