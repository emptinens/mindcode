import { describe, expect, test } from "bun:test";
import {
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  VexzyError,
  VexzyStreamError,
} from "./errors.js";
import {
  DEFAULT_VEXZY_MESSAGES_TIMEOUT_MS,
  createVexzyMessagesClient,
} from "./messagesClient.js";

const message = (overrides: Record<string, unknown> = {}) => ({
  type: "message",
  id: "msg_test",
  role: "assistant",
  model: "gpt-5.6-luna",
  content: [{ type: "text", text: "hello" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 4, output_tokens: 2 },
  ...overrides,
});

const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

const params = {
  model: "gpt-5.6-sol",
  max_tokens: 128,
  messages: [{ role: "user" as const, content: "hello" }],
  reasoning_effort: "max" as const,
};

const sse = (records: Array<Record<string, unknown>>) =>
  new Response(
    records
      .map(
        (record) =>
          `event: ${record.type}\ndata: ${JSON.stringify(record)}\n\n`,
      )
      .join(""),
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
        "request-id": "req_stream",
      },
    },
  );

describe("Vexzy native Messages client", () => {
  test("uses the runtime-compatible default timeout", () => {
    expect(DEFAULT_VEXZY_MESSAGES_TIMEOUT_MS).toBe(600_000);
  });

  test("posts JSON to Messages with Bearer auth and preserves reasoning_effort", async () => {
    let request: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (input, init) => {
        request = { input, init };
        return response(message(), 200, { "request-id": "req_123" });
      },
    });

    const result = await client.messages.create(params);
    const body = JSON.parse(String(request?.init?.body)) as Record<
      string,
      unknown
    >;

    expect(request?.input).toBe("https://api.echogate.one/v1/messages");
    expect(request?.init?.method).toBe("POST");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe(
      "Bearer forge-test-key",
    );
    expect(new Headers(request?.init?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(body.reasoning_effort).toBe("max");
    expect(body.stream).toBe(false);
    expect(result).toMatchObject({ id: "msg_test", model: "gpt-5.6-luna" });
  });

  test("clamps direct transport max_tokens to the model output ceiling", async () => {
    let body: Record<string, unknown> | undefined;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(message());
      },
    });

    await client.messages.create({ ...params, max_tokens: 999_999 });

    expect(body?.max_tokens).toBe(128_000);
  });

  test("rejects zero, negative, and fractional direct transport limits", async () => {
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => response(message()),
    });

    for (const max_tokens of [0, -1, 1.5]) {
      await expect(
        client.messages.create({ ...params, max_tokens }),
      ).rejects.toMatchObject({ code: "invalid_request" });
    }
  });

  test("forces non-streaming requests to send stream=false", async () => {
    const bodies: Record<string, unknown>[] = [];
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return response(message());
      },
    });

    await client.messages.create({ ...params, stream: true });
    await client.messages.createWithResponse({ ...params, stream: true });

    expect(bodies).toHaveLength(2);
    expect(bodies.map((body) => body.stream)).toEqual([false, false]);
  });

  test("dispatches an immutable prompt snapshot without transport credentials", async () => {
    let body: Record<string, unknown> | undefined;
    let calls = 0;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        calls += 1;
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return response(message());
      },
    });
    const content = [
      {
        type: "tool_result",
        tool_use_id: "tool-1",
        content: [{ type: "text", text: "original" }],
        input: { api_key: "prompt-content-only" },
      },
    ];
    const request = {
      ...params,
      messages: [{ role: "user" as const, content }],
    };

    const pending = client.messages.create(request);
    const toolResult = content[0];
    const textBlock = toolResult?.content[0];
    if (!toolResult || !textBlock) throw new Error("expected tool result fixture");
    textBlock.text = "mutated-after-dispatch";
    toolResult.input.api_key = "mutated-after-dispatch";
    await pending;

    expect(body?.messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tool-1",
            content: [{ type: "text", text: "original" }],
            input: { api_key: "prompt-content-only" },
          },
        ],
      },
    ]);

    await expect(
      client.messages.create({
        ...params,
        headers: { Authorization: "Bearer must-not-enter-request-data" },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(calls).toBe(1);
  });

  test("supports create(...).withResponse() with response headers and request-id", async () => {
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () =>
        response(message(), 200, {
          "request-id": "req_with_response",
          "x-extra": "preserved",
        }),
    });

    const result = await client.messages.create(params).withResponse();

    expect(result.data.id).toBe("msg_test");
    expect(result.response.status).toBe(200);
    expect(result.response.requestId).toBe("req_with_response");
    expect(result.response.headers.get("x-extra")).toBe("preserved");
  });

  test("streams SSE events through the Vexzy parser and exposes response metadata", async () => {
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        expect(JSON.parse(String(init?.body))).toMatchObject({
          stream: true,
          reasoning_effort: "high",
          max_tokens: 128_000,
        });
        return sse([
          {
            type: "message_start",
            message: message({ content: [] }),
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "hello" },
          },
          { type: "message_stop" },
        ]);
      },
    });

    const stream = client.messages.stream({
      ...params,
      max_tokens: 999_999,
      reasoning_effort: "high",
    });
    const events = [];
    for await (const event of stream) events.push(event);

    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_delta",
      "message_stop",
    ]);
    expect(await stream.response).toMatchObject({
      status: 200,
      requestId: "req_stream",
    });
  });

  test("starts a stream request when response metadata is awaited", async () => {
    let calls = 0;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        calls += 1;
        return sse([{ type: "message_stop" }]);
      },
    });

    const stream = client.messages.stream(params);
    expect(calls).toBe(1);
    await expect(stream.response).resolves.toMatchObject({ status: 200 });

    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual(["message_stop"]);
    expect(calls).toBe(1);
  });

  test("rejects late success after JSON completes when the caller aborts", async () => {
    const controller = new AbortController();
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers(),
          body: null,
          json: async () => {
            queueMicrotask(() => controller.abort());
            return message();
          },
        }) as Response,
    });

    await expect(
      client.messages.create(params, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  test("rejects a fetch response that arrives after the caller aborts", async () => {
    const controller = new AbortController();
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        queueMicrotask(() => controller.abort());
        return response(message());
      },
    });

    await expect(
      client.messages.create(params, { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
  });

  test("rejects late stream data after a read completes when the caller aborts", async () => {
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      pull(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        );
        streamController.close();
        queueMicrotask(() => controller.abort());
      },
    });
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    });

    const stream = client.messages.stream(params, {
      signal: controller.signal,
    });
    const iterator = stream[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: "aborted" });
  });

  test("retries 429 using Retry-After and then succeeds", async () => {
    let calls = 0;
    const delays: number[] = [];
    let retryBodyCanceled = false;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response(
              new ReadableStream({
                cancel() {
                  retryBodyCanceled = true;
                },
              }),
              { status: 429, headers: { "retry-after": "7" } },
            )
          : response(message());
      },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    await expect(await client.messages.create(params)).toBeDefined();
    expect(calls).toBe(2);
    expect(delays).toEqual([7000]);
    expect(retryBodyCanceled).toBe(true);
  });

  test("bounds 503 retries according to vexzy/errors.ts", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        calls += 1;
        return response("server-only body", 503);
      },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    let thrown: unknown;
    try {
      await client.messages.create(params);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: "VexzyError",
      status: 503,
      kind: "service_unavailable",
    });
    expect(calls).toBe(4);
    expect(delays).toEqual([500, 1000, 2000]);
  });

  test("honors client and per-request maxRetries", async () => {
    let calls = 0;
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      maxRetries: 0,
      fetch: async () => {
        calls += 1;
        return response("retryable", 503);
      },
      sleep: async () => {},
    });

    await expect(client.messages.create(params)).rejects.toMatchObject({
      status: 503,
    });
    expect(calls).toBe(1);

    await expect(
      client.messages.create(params, { maxRetries: 1 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
  });

  test.each([401, 402])(
    "treats %d as terminal and never reads the response body",
    async (status) => {
      let bodyRead = false;
      let bodyCanceled = false;
      const client = createVexzyMessagesClient({
        apiKey: "forge-secret-key",
        fetch: async () =>
          ({
            ok: false,
            status,
            headers: new Headers(),
            json: async () => {
              bodyRead = true;
              return { secret: "server-body" };
            },
            body: new ReadableStream({
              cancel() {
                bodyCanceled = true;
              },
            }),
          }) as Response,
        sleep: async () => {
          throw new Error("terminal error was retried");
        },
      });

      let thrown: unknown;
      try {
        await client.messages.create(params);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(VexzyError);
      expect(bodyRead).toBe(false);
      expect(bodyCanceled).toBe(true);
    },
  );

  test("cancels an early stream iterator but not a normally completed stream", async () => {
    let earlyCanceled = false;
    const earlyBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        );
      },
      cancel() {
        earlyCanceled = true;
      },
    });
    const earlyClient = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => new Response(earlyBody, { status: 200 }),
    });
    const earlyStream = earlyClient.messages.stream(params);
    const earlyIterator = earlyStream[Symbol.asyncIterator]();
    await expect(earlyIterator.next()).resolves.toMatchObject({
      value: { type: "message_stop" },
      done: false,
    });
    await earlyIterator.return?.();
    expect(earlyCanceled).toBe(true);

    let completedCanceled = false;
    const completedBody = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(
          new TextEncoder().encode(
            'event: message_stop\ndata: {"type":"message_stop"}\n\n',
          ),
        );
        streamController.close();
      },
      cancel() {
        completedCanceled = true;
      },
    });
    const completedClient = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => new Response(completedBody, { status: 200 }),
    });
    const completedEvents = [];
    for await (const event of completedClient.messages.stream(params)) {
      completedEvents.push(event);
    }
    expect(completedEvents).toHaveLength(1);
    expect(completedCanceled).toBe(false);
  });

  test("does not expose body or API key in HTTP, parse, or network errors", async () => {
    const httpClient = createVexzyMessagesClient({
      apiKey: "forge-secret-key",
      fetch: async () => response("server-body-secret", 400),
    });
    const parseClient = createVexzyMessagesClient({
      apiKey: "forge-secret-key",
      fetch: async () => response({ secret: "server-body-secret" }),
    });
    const networkClient = createVexzyMessagesClient({
      apiKey: "forge-secret-key",
      fetch: async () => {
        throw new Error("forge-secret-key server-body-secret");
      },
    });

    for (const pending of [
      httpClient.messages.create(params),
      parseClient.messages.create(params),
      networkClient.messages.create(params),
    ]) {
      let thrown: unknown;
      try {
        await pending;
      } catch (error) {
        thrown = error;
      }
      expect(String(thrown)).not.toContain("forge-secret-key");
      expect(String(thrown)).not.toContain("server-body-secret");
    }
  });

  test("maps caller abort and timeout without leaking fetch errors", async () => {
    const controller = new AbortController();
    const abortedClient = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("fetch abort detail");
      },
    });
    const aborted = abortedClient.messages.create(params, {
      signal: controller.signal,
    });
    controller.abort();
    let abortedError: unknown;
    try {
      await aborted;
    } catch (error) {
      abortedError = error;
    }
    expect(abortedError).toMatchObject({
      code: "aborted",
      name: "VexzyMessagesClientError",
    });

    const timeoutClient = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("fetch timeout detail");
      },
    });
    let timeoutError: unknown;
    try {
      await timeoutClient.messages.create(params);
    } catch (error) {
      timeoutError = error;
    }
    expect(timeoutError).toMatchObject({
      code: "timeout",
      name: "VexzyMessagesClientError",
    });
    expect(abortedError).toBeInstanceOf(APIError);
    expect(abortedError).toBeInstanceOf(APIUserAbortError);
    expect(timeoutError).toBeInstanceOf(APIConnectionTimeoutError);
  });

  test("does not convert a caller abort into a later timeout", async () => {
    const controller = new AbortController();
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      timeoutMs: 5,
      fetch: async (_input, init) => {
        await new Promise<void>((resolve) =>
          init?.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          }),
        );
        throw new Error("caller abort detail");
      },
    });
    const pending = client.messages.create(params, {
      signal: controller.signal,
    });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
  });

  test("handles stream response rejection when only iterator errors are consumed", async () => {
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () => {
        throw new Error("unobserved stream failure");
      },
    });
    const stream = client.messages.stream(params);
    let iteratorError: unknown;
    try {
      for await (const _event of stream) {
        // The request fails before any event is yielded.
      }
    } catch (error) {
      iteratorError = error;
    }

    expect(iteratorError).toMatchObject({ code: "network" });
  });

  test("maps provider SSE error events to an API-compatible stream error", async () => {
    const client = createVexzyMessagesClient({
      apiKey: "forge-test-key",
      fetch: async () =>
        new Response(
          'event: error\ndata: {"type":"error","error":{"message":"secret body"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    });

    let thrown: unknown;
    try {
      for await (const _event of client.messages.stream(params)) {
        // The provider error terminates the stream before any event is yielded.
      }
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(APIError);
    expect(thrown).toBeInstanceOf(VexzyStreamError);
    expect(thrown).toMatchObject({ code: "stream", name: "VexzyStreamError" });
    expect(String(thrown)).not.toContain("secret body");
  });
});
