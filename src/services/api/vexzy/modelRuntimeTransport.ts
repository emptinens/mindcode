import type {
  ModelTransport,
  TransportContentBlock,
  TransportJsonValue,
  TransportRequest,
  TransportRequestOptions,
  TransportResponse,
  TransportStream,
  TransportStreamEvent,
  TransportUsage,
} from "../../modelTransport/index.js";
import { ModelTransportError as ModelTransportErrorClass } from "../../modelTransport/index.js";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "./errors.js";
import { VexzyModelTransportAdapter } from "./modelTransportAdapter.js";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaRawContentBlockDelta,
  BetaRawMessageStreamEvent,
  BetaStopReason,
  BetaToolUnion,
  BetaUsage,
  VexzyClient,
  VexzyStream,
} from "./protocolTypes.js";
import type { VexzySDKClient } from "./sdkAdapter.js";

/**
 * The runtime still consumes the historical VEXZY protocol types in a few
 * hundred stream-processing lines. This is the single audited compatibility
 * bridge: modelRuntime talks to ModelTransport, and only this file translates
 * the neutral result back to those local runtime shapes.
 */
export interface RuntimeTransportResult {
  readonly data: BetaMessage;
  readonly response: Response;
  readonly request_id?: string;
}

export interface RuntimeTransportStreamResult {
  readonly data: VexzyStream<BetaRawMessageStreamEvent>;
  readonly response: Response;
  readonly request_id?: string;
}

export function createRuntimeModelTransport(
  client: VexzyClient,
): ModelTransport {
  return new VexzyModelTransportAdapter({
    client: client as unknown as VexzySDKClient,
  });
}

export async function completeRuntimeRequest(
  client: VexzyClient,
  params: BetaMessageStreamParams,
  options: TransportRequestOptions = {},
): Promise<RuntimeTransportResult> {
  try {
    const result = await createRuntimeModelTransport(client).complete(
      toTransportRequest(params),
      options,
    );
    return {
      data: fromTransportResponse(result.data),
      response: toResponse(result.response),
      ...(result.response.requestId !== undefined && {
        request_id: result.response.requestId,
      }),
    };
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function countRuntimeInputTokens(
  client: VexzyClient,
  params: BetaMessageStreamParams,
  options: TransportRequestOptions = {},
): Promise<number> {
  try {
    const result = await createRuntimeModelTransport(client).countInputTokens(
      toTransportRequest(params),
      options,
    );
    return result.inputTokens;
  } catch (error) {
    throw toRuntimeError(error);
  }
}

export async function streamRuntimeRequest(
  client: VexzyClient,
  params: BetaMessageStreamParams,
  options: TransportRequestOptions = {},
): Promise<RuntimeTransportStreamResult> {
  let transportStream: TransportStream;
  try {
    transportStream = createRuntimeModelTransport(client).stream(
      toTransportRequest(params),
      options,
    );
  } catch (error) {
    throw toRuntimeError(error);
  }

  const metadata = transportStream.response.catch((error) => {
    throw toRuntimeError(error);
  });
  const response = metadata.then(toResponse);
  const controller = new AbortController();
  const abortTransport = () => transportStream.abort();
  controller.signal.addEventListener("abort", abortTransport, { once: true });
  const iterator = transportStream[Symbol.asyncIterator]();

  const stream: VexzyStream<BetaRawMessageStreamEvent> = {
    controller,
    response,
    request_id: metadata.then((value) => value.requestId),
    get aborted() {
      return controller.signal.aborted || transportStream.aborted;
    },
    abort() {
      if (!controller.signal.aborted) controller.abort();
      transportStream.abort();
    },
    async next(...args: [] | [undefined]) {
      try {
        const result = await iterator.next(...args);
        if (result.done)
          controller.signal.removeEventListener("abort", abortTransport);
        return result.done
          ? result
          : { done: false, value: fromTransportStreamEvent(result.value) };
      } catch (error) {
        throw toRuntimeError(error);
      }
    },
    async return(value?: unknown) {
      stream.abort();
      if (iterator.return !== undefined) {
        try {
          return (await iterator.return(value as undefined)) as unknown as IteratorResult<BetaRawMessageStreamEvent>;
        } catch (error) {
          throw toRuntimeError(error);
        }
      }
      return { done: true, value: value as undefined };
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };

  const responseValue = await metadata;
  return {
    data: stream,
    response: toResponse(responseValue),
    ...(responseValue.requestId !== undefined && {
      request_id: responseValue.requestId,
    }),
  };
}

export function toTransportRequest(
  params: BetaMessageStreamParams,
): TransportRequest {
  const {
    model,
    max_tokens,
    messages,
    system,
    tools,
    tool_choice,
    reasoning_effort,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    metadata,
    stream: _stream,
    ...extensions
  } = params;

  return {
    model,
    maxOutputTokens: max_tokens,
    messages: messages.map(toTransportMessage),
    ...(system !== undefined && { system: toTransportSystem(system) }),
    ...(reasoning_effort !== undefined && {
      reasoningEffort: reasoning_effort,
    }),
    ...(temperature !== undefined && { temperature }),
    ...(top_p !== undefined && { topP: top_p }),
    ...(top_k !== undefined && { topK: top_k }),
    ...(stop_sequences !== undefined && { stopSequences: stop_sequences }),
    ...(tools !== undefined && { tools: tools.map(toTransportTool) }),
    ...(tool_choice !== undefined && {
      toolChoice: toTransportToolChoice(tool_choice),
    }),
    ...(metadata !== undefined && {
      metadata: metadata as unknown as Readonly<
        Record<string, TransportJsonValue>
      >,
    }),
    ...(Object.keys(extensions).length > 0 && {
      extensions: extensions as unknown as Readonly<
        Record<string, TransportJsonValue>
      >,
    }),
  };
}

function toTransportMessage(message: BetaMessageParam) {
  return {
    role: message.role,
    content: message.content as string | readonly TransportContentBlock[],
  };
}

function toTransportSystem(
  system: NonNullable<BetaMessageStreamParams["system"]>,
): string | readonly TransportContentBlock[] {
  return typeof system === "string"
    ? system
    : (system as unknown as readonly TransportContentBlock[]);
}

function toTransportTool(tool: BetaToolUnion) {
  const record = tool as unknown as Record<string, unknown>;
  const { name, description, input_schema, ...extensions } = record;
  return {
    name: name as string,
    ...(typeof description === "string" && { description }),
    ...(isRecord(input_schema) && {
      inputSchema: input_schema as Readonly<Record<string, unknown>>,
    }),
    ...(Object.keys(extensions).length > 0 && {
      extensions: extensions as unknown as Readonly<
        Record<string, TransportJsonValue>
      >,
    }),
  };
}

function toTransportToolChoice(
  choice: NonNullable<BetaMessageStreamParams["tool_choice"]>,
) {
  switch (choice.type) {
    case "auto":
      return { kind: "auto" as const };
    case "any":
      return { kind: "any" as const };
    case "none":
      return { kind: "none" as const };
    case "tool":
      return { kind: "tool" as const, name: choice.name };
  }
}

function fromTransportResponse(response: TransportResponse): BetaMessage {
  return {
    ...(response.extensions as Record<string, unknown> | undefined),
    type: "message",
    id: response.id,
    role: "assistant",
    model: response.model,
    content: response.content.map((block) => block as unknown as BetaContentBlock),
    stop_reason: response.stopReason as BetaStopReason | null,
    stop_sequence: getStringOrNull(response.stopSequence),
    usage: fromTransportUsage(response.usage),
  };
}

function fromTransportUsage(usage: TransportUsage): BetaUsage {
  return {
    ...(usage.extensions as Record<string, unknown> | undefined),
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
    ...(usage.cacheWriteInputTokens !== undefined && {
      cache_creation_input_tokens: usage.cacheWriteInputTokens,
    }),
  } as BetaUsage;
}

function fromTransportStreamEvent(
  event: TransportStreamEvent,
): BetaRawMessageStreamEvent {
  switch (event.kind) {
    case "started":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "message_start",
        message: fromTransportResponse(event.response),
      } as BetaRawMessageStreamEvent;
    case "content_started":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "content_block_start",
        index: event.index,
        content_block: event.content as unknown as BetaContentBlock,
      };
    case "content_delta":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "content_block_delta",
        index: event.index,
        delta: event.delta as BetaRawContentBlockDelta,
      };
    case "content_stopped":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "content_block_stop",
        index: event.index,
      };
    case "keepalive":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "ping",
      };
    case "completed":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "message_delta",
        delta: {
          stop_reason: event.stopReason as BetaStopReason | null,
          stop_sequence: getStringOrNull(event.stopSequence),
        },
        usage: fromTransportDeltaUsage(event.usage),
      };
    case "stopped":
      return {
        ...(event.extensions as Record<string, unknown> | undefined),
        type: "message_stop",
      };
  }
}

function fromTransportDeltaUsage(
  usage: Partial<TransportUsage>,
): BetaMessageDeltaUsage {
  return {
    ...(usage.extensions as Record<string, unknown> | undefined),
    output_tokens: usage.outputTokens ?? 0,
    ...(usage.inputTokens !== undefined && { input_tokens: usage.inputTokens }),
    ...(usage.cacheReadInputTokens !== undefined && {
      cache_read_input_tokens: usage.cacheReadInputTokens,
    }),
    ...(usage.cacheWriteInputTokens !== undefined && {
      cache_creation_input_tokens: usage.cacheWriteInputTokens,
    }),
  } as BetaMessageDeltaUsage;
}

function toResponse(metadata: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}): Response {
  return new Response(null, {
    status: metadata.status,
    headers: metadata.headers,
  });
}

function toRuntimeError(error: unknown): unknown {
  if (!(error instanceof ModelTransportErrorClass)) return error;
  const cause = error.cause;
  if (cause instanceof APIError) return cause;
  if (error.code === "aborted") return new APIUserAbortError();
  if (error.code === "timeout") {
    return new APIConnectionTimeoutError({ message: error.message });
  }
  if (error.code === "network") {
    return new APIConnectionError({ message: error.message, cause });
  }
  if (error.status !== undefined) {
    return new APIError(error.status, cause, error.message, undefined);
  }
  return error;
}

function getStringOrNull(value: unknown): string | null {
  return typeof value === "string" || value === null ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
