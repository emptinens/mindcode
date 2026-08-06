import { describe, expect, test } from "bun:test";
import { ModelTransportError } from "../../modelTransport/index.js";
import type { TransportRequest } from "../../modelTransport/index.js";
import {
  VexzyModelTransportAdapter,
  createVexzyModelTransport,
} from "./modelTransportAdapter.js";
import type {
  VexzySDKClient,
  VexzySDKMessageParams,
  VexzySDKPromise,
  VexzySDKResponse,
  VexzySDKStream,
} from "./sdkAdapter.js";

const request: TransportRequest = {
  model: "gpt-5.6-luna",
  maxOutputTokens: 256,
  messages: [{ role: "user", content: "hello" }],
  reasoningEffort: "high",
  tools: [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object" },
    },
  ],
  toolChoice: { kind: "auto" },
  outputFormat: { type: "json", schema: { type: "object" } },
};

const message = () => ({
  type: "message" as const,
  id: "msg_1",
  role: "assistant" as const,
  model: "gpt-5.6-luna",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
});

function promise<T>(
  value: T,
  response = new Response(null, { status: 200 }),
): VexzySDKPromise<T> {
  const result = Promise.resolve(value) as VexzySDKPromise<T>;
  const settled: Promise<VexzySDKResponse<T>> = Promise.resolve({
    data: value,
    response,
    request_id: "req_1",
  });
  result.withResponse = async () => settled;
  result.asResponse = async () => response;
  return result;
}

function clientFor(
  create: (params: VexzySDKMessageParams) => VexzySDKPromise<unknown>,
): VexzySDKClient {
  const models = {
    list: () =>
      promise({
        data: [
          {
            id: "gpt-5.6-luna",
            display_name: "GPT-5.6 Luna",
            type: "model" as const,
            available: true,
            context_length: 1_100_000,
            supported_reasoning_efforts: ["none", "low", "max"],
          },
        ],
        async *[Symbol.asyncIterator]() {
          yield {
            id: "gpt-5.6-luna",
            display_name: "GPT-5.6 Luna",
            type: "model" as const,
          };
        },
      }),
  };
  const messages = {
    create,
    stream: () => {
      throw new Error("stream is not used by this test");
    },
    countTokens: () => promise({ input_tokens: 7 }),
  };
  return { messages, models, beta: { messages } } as VexzySDKClient;
}

describe("VEXZY provider adapter for the neutral transport", () => {
  test("translates neutral requests at the VEXZY boundary", async () => {
    let seen: VexzySDKMessageParams | undefined;
    const client = clientFor((params) => {
      seen = params;
      return promise(message());
    });
    const transport = new VexzyModelTransportAdapter({ client });
    const result = await transport.complete(request, {
      timeoutMs: 123,
      maxRetries: 2,
      headers: { "x-test": "yes" },
    });

    expect(seen).toMatchObject({
      model: "gpt-5.6-luna",
      max_tokens: 256,
      reasoning_effort: "high",
      output_config: { format: { type: "json", schema: { type: "object" } } },
      tools: [
        {
          name: "lookup",
          description: "Look up a value",
          input_schema: { type: "object" },
        },
      ],
    });
    expect(result.data).toEqual({
      id: "msg_1",
      model: "gpt-5.6-luna",
      content: [{ type: "text", text: "hello" }],
      stopReason: "end_turn",
      usage: { inputTokens: 4, outputTokens: 2 },
    });
    expect(result.response.requestId).toBe("req_1");
  });

  test("maps token counts and model catalog without provider field names", async () => {
    const transport = createVexzyModelTransport({
      client: clientFor(() => promise(message())),
    });
    await expect(transport.countInputTokens(request)).resolves.toEqual({
      inputTokens: 7,
    });
    await expect(transport.listModels()).resolves.toEqual([
      {
        id: "gpt-5.6-luna",
        displayName: "GPT-5.6 Luna",
        available: true,
        contextLength: 1_100_000,
        reasoningEfforts: ["none", "low", "max"],
      },
    ]);
  });

  test("maps streamed protocol events to semantic events", async () => {
    const source = ({
      controller: new AbortController(),
      response: Promise.resolve(new Response(null, { status: 200 })),
      request_id: Promise.resolve("stream_1"),
      aborted: false,
      abort() {
        (this as VexzySDKStream).controller.abort();
      },
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message_start",
          message: message(),
        };
        yield { type: "ping" };
        yield {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        };
        yield {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        };
        yield { type: "content_block_stop", index: 0 };
        yield {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 2 },
        };
      },
    } as unknown as VexzySDKStream);
    const client = clientFor(() => promise(source));
    const transport = new VexzyModelTransportAdapter({ client });
    const stream = transport.stream(request);
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "keepalive",
      "content_started",
      "content_delta",
      "content_stopped",
      "completed",
    ]);
    expect(events[3]).toMatchObject({
      kind: "content_delta",
      index: 0,
      delta: { type: "text_delta", text: "hi" },
    });
    await expect(stream.response).resolves.toMatchObject({
      requestId: "req_1",
    });
  });

  test("normalizes adapter failures to the neutral error type", async () => {
    const client = clientFor(() => {
      const error = new Error("provider details");
      Object.assign(error, { code: "timeout", status: 504 });
      const failed = Promise.resolve(message()) as VexzySDKPromise<unknown>;
      failed.withResponse = async () => Promise.reject(error);
      failed.asResponse = async () => Promise.reject(error);
      return failed;
    });
    const transport = new VexzyModelTransportAdapter({ client });

    await expect(transport.complete(request)).rejects.toEqual(
      new ModelTransportError("timeout", 504),
    );
  });
});
