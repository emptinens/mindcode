import type {
  ModelTransport,
  TransportContentBlock,
  TransportMessage,
  TransportModelInfo,
  TransportRequest,
  TransportRequestOptions,
  TransportResponse,
  TransportResponseMetadata,
  TransportResult,
  TransportStream,
  TransportStreamEvent,
  TransportTokenCount,
  TransportToolChoice,
  TransportJsonValue,
  TransportUsage,
} from "../../modelTransport/index.js";
import { ModelTransportError } from "../../modelTransport/index.js";
import type { VexzyMessage, VexzyStreamEvent } from "./messagesProtocol.js";
import {
  type VexzySDKAdapterOptions,
  type VexzySDKClient,
  type VexzySDKMessageParams,
  type VexzySDKRequestOptions,
  type VexzySDKStream,
  createVexzySDKAdapter,
} from "./sdkAdapter.js";

export interface VexzyModelTransportOptions extends VexzySDKAdapterOptions {
  readonly client?: VexzySDKClient;
}

/**
 * VEXZY's protocol adapter for the provider-neutral model transport.
 *
 * All protocol naming and wire-shape translation is kept in this file. The
 * public interface imported by callers contains no provider-specific types.
 */
export class VexzyModelTransportAdapter implements ModelTransport {
  private readonly client: VexzySDKClient;

  constructor(options: VexzyModelTransportOptions = {}) {
    this.client = options.client ?? createVexzySDKAdapter(options);
  }

  async complete(
    request: TransportRequest,
    options: TransportRequestOptions = {},
  ): Promise<TransportResult> {
    try {
      const pending = this.client.messages.create(
        toVexzyRequest(request),
        toVexzyRequestOptions(options),
      );
      const result = await pending.withResponse();
      return {
        data: toTransportResponse(result.data as VexzyMessage),
        response: toTransportResponseMetadata(
          result.response,
          result.request_id,
        ),
      };
    } catch (error) {
      throw toTransportError(error);
    }
  }

  stream(
    request: TransportRequest,
    options: TransportRequestOptions = {},
  ): TransportStream {
    const pending = this.client.messages.create(
      {
        ...toVexzyRequest(request),
        stream: true,
      } as VexzySDKMessageParams & { readonly stream: true },
      toVexzyRequestOptions(options),
    );
    let source: VexzySDKStream | undefined;
    let abortRequested = false;
    const sourcePromise = pending.then(
      (value) => {
        source = value as VexzySDKStream;
        if (abortRequested) source.abort();
        return source;
      },
      (error) => {
        throw toTransportError(error);
      },
    );

    const response = pending.withResponse().then(
      (result) =>
        toTransportResponseMetadata(result.response, result.request_id),
      (error) => {
        throw toTransportError(error);
      },
    );

    const events = async function* (): AsyncGenerator<TransportStreamEvent> {
      const stream = await sourcePromise;
      for await (const event of stream) {
        yield toTransportStreamEvent(event);
      }
    };

    return {
      response,
      get aborted() {
        return abortRequested || source?.aborted === true;
      },
      abort() {
        abortRequested = true;
        source?.abort();
      },
      [Symbol.asyncIterator]() {
        return events();
      },
    };
  }

  async countInputTokens(
    request: TransportRequest,
    options: TransportRequestOptions = {},
  ): Promise<TransportTokenCount> {
    try {
      const result = await this.client.beta.messages
        .countTokens(toVexzyRequest(request), toVexzyRequestOptions(options))
        .withResponse();
      return { inputTokens: result.data.input_tokens };
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async listModels(
    options: TransportRequestOptions = {},
  ): Promise<readonly TransportModelInfo[]> {
    try {
      const result = await this.client.models
        .list(undefined, toVexzyRequestOptions(options))
        .withResponse();
      return result.data.data.map((model) => ({
        id: model.id,
        displayName: model.display_name,
        ...(model.available !== undefined && { available: model.available }),
        ...(model.context_length !== undefined && {
          contextLength: model.context_length,
        }),
        ...(model.supported_reasoning_efforts !== undefined && {
          reasoningEfforts: model.supported_reasoning_efforts,
        }),
      }));
    } catch (error) {
      throw toTransportError(error);
    }
  }
}

export function createVexzyModelTransport(
  options: VexzyModelTransportOptions = {},
): ModelTransport {
  return new VexzyModelTransportAdapter(options);
}

function toVexzyRequest(request: TransportRequest): VexzySDKMessageParams {
  return {
    ...(request.extensions ?? {}),
    model: request.model,
    max_tokens: request.maxOutputTokens,
    messages: request.messages.map(toVexzyMessage),
    ...(request.system !== undefined && { system: request.system }),
    ...(request.reasoningEffort !== undefined && {
      reasoning_effort: request.reasoningEffort,
    }),
    ...(request.temperature !== undefined && {
      temperature: request.temperature,
    }),
    ...(request.topP !== undefined && { top_p: request.topP }),
    ...(request.topK !== undefined && { top_k: request.topK }),
    ...(request.stopSequences !== undefined && {
      stop_sequences: request.stopSequences,
    }),
    ...(request.tools !== undefined && {
      tools: request.tools.map((tool) => ({
        ...(tool.extensions ?? {}),
        name: tool.name,
        ...(tool.description !== undefined && {
          description: tool.description,
        }),
        ...(tool.inputSchema !== undefined && {
          input_schema: tool.inputSchema,
        }),
      })),
    }),
    ...(request.toolChoice !== undefined && {
      tool_choice: toVexzyToolChoice(request.toolChoice),
    }),
    ...(request.metadata !== undefined && { metadata: request.metadata }),
    ...(request.outputFormat !== undefined && {
      output_config: {
        ...(isRecord(request.extensions?.output_config)
          ? request.extensions.output_config
          : {}),
        format: request.outputFormat,
      },
    }),
  };
}

function toVexzyMessage(
  message: TransportMessage,
): Readonly<Record<string, unknown>> {
  return { role: message.role, content: message.content };
}

function toVexzyToolChoice(
  choice: TransportToolChoice,
): Readonly<Record<string, unknown>> {
  switch (choice.kind) {
    case "auto":
      return { type: "auto" };
    case "any":
      return { type: "any" };
    case "none":
      return { type: "none" };
    case "tool":
      return { type: "tool", name: choice.name };
  }
}

function toVexzyRequestOptions(
  options: TransportRequestOptions,
): VexzySDKRequestOptions {
  return {
    signal: options.signal,
    timeout: options.timeoutMs,
    maxRetries: options.maxRetries,
    ...(options.headers !== undefined && { headers: options.headers }),
  };
}

function toTransportResponse(response: VexzyMessage): TransportResponse {
  const extensions = toTransportExtensions(
    response as unknown as Record<string, unknown>,
    [
      "type",
      "id",
      "role",
      "model",
      "content",
      "stop_reason",
      "stop_sequence",
      "usage",
    ],
  );
  return {
    id: response.id,
    model: response.model,
    content: response.content.map((block) =>
      normalizeContentBlock(
        block as unknown as Readonly<Record<string, unknown>>,
      ),
    ),
    stopReason: response.stop_reason,
    ...(response.stop_sequence !== undefined &&
      response.stop_sequence !== null && {
        stopSequence: response.stop_sequence,
      }),
    usage: toTransportUsage(response.usage),
    ...(extensions !== undefined && { extensions }),
  };
}

function normalizeContentBlock(
  block: Readonly<Record<string, unknown>>,
): TransportContentBlock {
  return { ...block };
}

function toTransportUsage(
  usage: Readonly<Record<string, unknown>>,
): TransportUsage {
  const extensions = toTransportExtensions(usage, [
    "input_tokens",
    "output_tokens",
    "cache_read_input_tokens",
    "cache_creation_input_tokens",
  ]);
  return {
    inputTokens: numberOrZero(usage.input_tokens),
    outputTokens: numberOrZero(usage.output_tokens),
    ...(numberOrUndefined(usage.cache_read_input_tokens) !== undefined && {
      cacheReadInputTokens: numberOrUndefined(usage.cache_read_input_tokens),
    }),
    ...(numberOrUndefined(usage.cache_creation_input_tokens) !== undefined && {
      cacheWriteInputTokens: numberOrUndefined(
        usage.cache_creation_input_tokens,
      ),
    }),
    ...(extensions !== undefined && { extensions }),
  };
}

function toTransportResponseMetadata(
  response: Response,
  requestId: string | null | undefined,
): TransportResponseMetadata {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    status: response.status,
    headers,
    ...(requestId !== undefined && requestId !== null && { requestId }),
  };
}

function toTransportStreamEvent(event: VexzyStreamEvent): TransportStreamEvent {
  switch (event.type) {
    case "message_start":
      return {
        kind: "started",
        response: toTransportResponse(event.message),
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type", "message"],
        ),
      };
    case "ping":
      return {
        kind: "keepalive",
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type"],
        ),
      };
    case "content_block_start":
      return {
        kind: "content_started",
        index: event.index,
        content: normalizeContentBlock(
          event.content_block as unknown as Readonly<Record<string, unknown>>,
        ),
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type", "index", "content_block"],
        ),
      };
    case "content_block_delta":
      return {
        kind: "content_delta",
        index: event.index,
        delta: { ...event.delta },
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type", "index", "delta"],
        ),
      };
    case "content_block_stop":
      return {
        kind: "content_stopped",
        index: event.index,
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type", "index"],
        ),
      };
    case "message_delta":
      return {
        kind: "completed",
        stopReason: event.delta.stop_reason,
        stopSequence: event.delta.stop_sequence,
        usage: {
          outputTokens: numberOrZero(event.usage.output_tokens),
          ...(numberOrUndefined(event.usage.input_tokens) !== undefined && {
            inputTokens: numberOrUndefined(event.usage.input_tokens),
          }),
          extensions: toTransportExtensions(
            event.usage as unknown as Record<string, unknown>,
            ["input_tokens", "output_tokens"],
          ),
        },
        extensions: {
          ...toTransportExtensions(
            event as unknown as Record<string, unknown>,
            ["type", "delta", "usage"],
          ),
          ...toTransportExtensions(
            event.delta as unknown as Record<string, unknown>,
            ["stop_reason", "stop_sequence"],
          ),
        },
      };
    case "message_stop":
      return {
        kind: "stopped",
        extensions: toTransportExtensions(
          event as unknown as Record<string, unknown>,
          ["type"],
        ),
      };
  }
}

function toTransportError(error: unknown): ModelTransportError {
  if (error instanceof ModelTransportError) return error;
  const record = isRecord(error) ? error : undefined;
  const rawCode = record?.code;
  const code =
    rawCode === "aborted" ||
    rawCode === "timeout" ||
    rawCode === "network" ||
    rawCode === "invalid_request" ||
    rawCode === "invalid_response"
      ? rawCode
      : record?.name === "AbortError"
        ? "aborted"
        : "request_failed";
  const status = numberOrUndefined(record?.status);
  const cause =
    record !== undefined &&
    ("headers" in record || "error" in record || "request_id" in record)
      ? error
      : undefined;
  return new ModelTransportError(code, status, cause);
}

function toTransportExtensions(
  record: Readonly<Record<string, unknown>>,
  excluded: readonly string[],
): Readonly<Record<string, TransportJsonValue>> | undefined {
  const excludedSet = new Set(excluded);
  const extensions: Record<string, TransportJsonValue> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!excludedSet.has(key)) {
      extensions[key] = value as TransportJsonValue;
    }
  }
  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

function numberOrZero(value: unknown): number {
  return numberOrUndefined(value) ?? 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}
