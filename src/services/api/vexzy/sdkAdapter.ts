import type { VexzyHeaders } from "./auth.js";
import {
  type VexzyConfig,
  createVexzyConfig,
  getVexzyConfig,
} from "./config.js";
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  VexzyBaseError,
  VexzyError,
} from "./errors.js";
import {
  type VexzyFetch,
  type VexzyInputMessage,
  type VexzyMessageCreateParams,
  type VexzyMessagesRequestOptions,
  type VexzyResponseMetadata,
  VexzyMessagesClientError,
  createVexzyMessagesClient,
} from "./messagesClient.js";
import type { VexzyMessage, VexzyStreamEvent } from "./messagesProtocol.js";
import {
  type VexzyModelClient,
  type VexzyModelLoadOptions,
  VexzyModelClientError,
  createVexzyModelClient,
} from "./modelClient.js";

/** The deliberately small RequestOptions subset used by current consumers. */
export interface VexzySDKRequestOptions {
  readonly headers?: Readonly<Record<string, string | null | undefined>>;
  readonly signal?: AbortSignal | null;
  readonly timeout?: number;
  readonly maxRetries?: number;
  readonly betas?: readonly string[];
  readonly [key: string]: unknown;
}

export interface VexzySDKMessageParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface VexzySDKResponse<T> {
  readonly data: T;
  readonly response: Response;
  readonly request_id: string | null | undefined;
}

export interface VexzySDKPromise<T> extends Promise<T> {
  asResponse(): Promise<Response>;
  withResponse(): Promise<VexzySDKResponse<T>>;
}

export interface VexzySDKStream extends AsyncIterable<VexzyStreamEvent> {
  readonly controller: AbortController;
  readonly response: Promise<Response>;
  readonly request_id: Promise<string | null | undefined>;
  readonly aborted: boolean;
  next(...args: [] | [undefined]): Promise<IteratorResult<VexzyStreamEvent>>;
  return?(value?: unknown): Promise<IteratorResult<VexzyStreamEvent>>;
  abort(): void;
}

export interface VexzySDKMessageTokensCount {
  readonly input_tokens: number;
  readonly [key: string]: unknown;
}

export interface VexzySDKModelInfo {
  readonly id: string;
  readonly created_at?: string;
  readonly display_name: string;
  readonly type: "model";
  readonly available?: boolean;
  readonly context_length?: number;
  readonly supported_reasoning_efforts?: readonly string[];
}

export interface VexzySDKModelList extends AsyncIterable<VexzySDKModelInfo> {
  readonly data: readonly VexzySDKModelInfo[];
}

export interface VexzySDKMessages {
  create(
    params: VexzySDKMessageParams & { readonly stream: true },
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzySDKStream>;
  create(
    params: VexzySDKMessageParams & { readonly stream?: false },
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzyMessage>;
  create(
    params: VexzySDKMessageParams,
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzyMessage | VexzySDKStream>;
  stream(
    params: VexzySDKMessageParams,
    options?: VexzySDKRequestOptions,
  ): VexzySDKStream;
  countTokens(
    params: Readonly<Record<string, unknown>>,
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzySDKMessageTokensCount>;
}

export interface VexzySDKModels {
  list(
    query?: Readonly<Record<string, unknown>> | VexzySDKRequestOptions,
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzySDKModelList>;
}

export interface VexzySDKClient {
  readonly messages: VexzySDKMessages;
  readonly models: VexzySDKModels;
  readonly beta: { readonly messages: VexzySDKMessages };
}

export interface VexzySDKAdapterOptions {
  readonly apiKey?: string;
  readonly config?: VexzyConfig;
  readonly fetch?: VexzyFetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/**
 * Native Vexzy implementation of the bounded SDK surface used by MindCode.
 * It intentionally does not import the Anthropic SDK at runtime.
 */
export class VexzySDKAdapter implements VexzySDKClient {
  private readonly config: VexzyConfig;
  private readonly fetchImpl: VexzyFetch;
  private readonly timeoutMs: number;
  private readonly maxRetries: number | undefined;
  private readonly now: () => number;
  private readonly sleep?: VexzySDKAdapterOptions["sleep"];
  private readonly modelClient: VexzyModelClient;

  readonly messages: VexzySDKMessages;
  readonly models: VexzySDKModels;
  readonly beta: { readonly messages: VexzySDKMessages };

  constructor(options: VexzySDKAdapterOptions = {}) {
    this.config =
      options.config ??
      (options.apiKey === undefined
        ? getVexzyConfig()
        : createVexzyConfig(options.apiKey));
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxRetries = options.maxRetries;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep;
    this.modelClient = createVexzyModelClient({
      config: this.config,
      fetch: this.fetchImpl,
      timeoutMs: this.timeoutMs,
      now: this.now,
      sleep: options.sleep,
    });

    this.messages = {
      create: ((
        params: VexzySDKMessageParams,
        requestOptions?: VexzySDKRequestOptions,
      ) =>
        this.createMessage(
          params,
          requestOptions,
        )) as VexzySDKMessages["create"],
      stream: (params, requestOptions) =>
        this.createMessageStream(params, requestOptions),
      countTokens: (params, requestOptions) =>
        this.countTokens(params, requestOptions),
    };
    this.models = {
      list: (query, requestOptions) => this.listModels(query, requestOptions),
    };
    this.beta = { messages: this.messages };
  }

  private createMessage(
    params: VexzySDKMessageParams,
    options: VexzySDKRequestOptions = {},
  ): VexzySDKPromise<VexzyMessage | VexzySDKStream> {
    if (params.stream === true) {
      return this.createMessageStreamPromise(params, options);
    }

    const responseStore = new ResponseStore();
    const native = this.createNativeMessagesClient(options, responseStore);
    const normalizedParams = normalizeVexzyMessageParams(params);
    const request = native.messages.create(
      normalizedParams as VexzyMessageCreateParams,
      toNativeOptions(options),
    );
    const settled = request.withResponse().then(
      (result) => {
        const response = responseStore.take(result.response);
        return {
          data: result.data,
          response,
          request_id: result.response.requestId,
        } satisfies VexzySDKResponse<VexzyMessage>;
      },
      (error) => {
        throw normalizeVexzySDKError(error);
      },
    );
    return decoratePromise(
      request.then(
        (result) => result,
        (error) => {
          throw normalizeVexzySDKError(error);
        },
      ),
      settled,
    );
  }

  private createMessageStreamPromise(
    params: VexzySDKMessageParams,
    options: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzySDKStream> {
    const stream = this.createMessageStream(params, options);
    const response = stream.response;
    const settled = response.then(
      async (rawResponse) => ({
        data: stream,
        response: rawResponse,
        request_id: await stream.request_id,
      }),
      (error) => {
        throw normalizeVexzySDKError(error);
      },
    );
    return decoratePromise(Promise.resolve(stream), settled);
  }

  private createMessageStream(
    params: VexzySDKMessageParams,
    options: VexzySDKRequestOptions = {},
  ): VexzySDKStream {
    const controller = new AbortController();
    const combined = combineSignals(options.signal ?? undefined, controller);
    const responseStore = new ResponseStore();
    const native = this.createNativeMessagesClient(options, responseStore);
    const nativeStream = native.messages.stream(
      {
        ...normalizeVexzyMessageParams(params),
        stream: true,
      } as VexzyMessageCreateParams,
      { signal: combined.signal, timeoutMs: options.timeout },
    );
    let aborted = false;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      combined.cleanup();
    };
    const responseMetadata = nativeStream.response.then(
      (metadata) => {
        const response = responseStore.take(metadata);
        return { response, metadata };
      },
      (error) => {
        throw normalizeVexzySDKError(error);
      },
    );
    const iterator = nativeStream[Symbol.asyncIterator]();

    const stream: VexzySDKStream = {
      controller,
      get response() {
        return responseMetadata.then((result) => result.response);
      },
      get request_id() {
        return responseMetadata.then((result) => result.metadata.requestId);
      },
      get aborted() {
        return aborted || controller.signal.aborted;
      },
      abort: () => {
        aborted = true;
        controller.abort();
        cleanup();
      },
      async next(
        ...args: [] | [undefined]
      ): Promise<IteratorResult<VexzyStreamEvent>> {
        try {
          const result = await iterator.next(...args);
          if (result.done) cleanup();
          return result;
        } catch (error) {
          cleanup();
          throw normalizeVexzySDKError(error);
        }
      },
      async return(value?: unknown): Promise<IteratorResult<VexzyStreamEvent>> {
        stream.abort();
        cleanup();
        if (iterator.return !== undefined) {
          return iterator.return(value as undefined);
        }
        return { done: true, value: value as undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    };
    return stream;
  }

  private countTokens(
    params: Readonly<Record<string, unknown>>,
    options: VexzySDKRequestOptions = {},
  ): VexzySDKPromise<VexzySDKMessageTokensCount> {
    const request = this.executeCountTokens(params, options);
    const settled = request.then(
      ({ data, response, requestId }) => ({
        data,
        response,
        request_id: requestId,
      }),
      (error) => {
        throw normalizeVexzySDKError(error);
      },
    );
    return decoratePromise(
      request.then(
        (result) => result.data,
        (error) => {
          throw normalizeVexzySDKError(error);
        },
      ),
      settled,
    );
  }

  private async executeCountTokens(
    params: Readonly<Record<string, unknown>>,
    options: VexzySDKRequestOptions,
  ): Promise<{
    data: VexzySDKMessageTokensCount;
    response: Response;
    requestId: string | undefined;
  }> {
    if (options.signal?.aborted) {
      throw new VexzyMessagesClientError("aborted");
    }

    const data = { input_tokens: estimateVexzyInputTokens(params) };
    const response = new Response(JSON.stringify(data), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-mindcode-token-count-source": "local-estimate",
      },
    });
    return { data, response, requestId: undefined };
  }

  private listModels(
    query?: Readonly<Record<string, unknown>> | VexzySDKRequestOptions,
    options?: VexzySDKRequestOptions,
  ): VexzySDKPromise<VexzySDKModelList> {
    const requestOptions = options ?? (isRequestOptions(query) ? query : {});
    const loadOptions: VexzyModelLoadOptions = {
      signal: requestOptions.signal ?? undefined,
      timeoutMs: requestOptions.timeout,
      refresh: requestOptions.refresh === true,
    };
    const modelClient =
      requestOptions.headers === undefined
        ? this.modelClient
        : createVexzyModelClient({
            config: this.config,
            catalogCache: false,
            timeoutMs: this.timeoutMs,
            now: this.now,
            sleep: this.sleep,
            fetch: (input, init) =>
              this.fetchImpl(input, {
                ...init,
                headers: mergeHeaders(init?.headers, requestOptions.headers),
              }),
          });
    const loaded = modelClient.getModels(loadOptions).then((registry) => {
      const data = registry.models.map((model) => {
        const createdAt = (model.raw as unknown as { created_at?: unknown })
          .created_at;
        return {
          id: model.id,
          ...(typeof createdAt === "string" && { created_at: createdAt }),
          display_name: model.displayName,
          type: "model" as const,
          available: model.available,
          context_length: model.contextLength,
          supported_reasoning_efforts: model.supportedReasoningEfforts,
        };
      });
      const page = {
        data,
        async *[Symbol.asyncIterator]() {
          yield* data;
        },
      } satisfies VexzySDKModelList;
      const response = modelClient.getSnapshot()?.response?.clone();
      if (response === undefined) {
        throw new VexzyModelClientError("invalid_response");
      }
      return { page, response };
    });
    const request = loaded.then((result) => result.page);
    const settled = loaded.then(({ page, response }) => ({
      data: page,
      response,
      request_id: getRequestId(response.headers),
    }));
    return decoratePromise(request, settled);
  }

  private createNativeMessagesClient(
    options: VexzySDKRequestOptions,
    responseStore: ResponseStore,
  ) {
    return createVexzyMessagesClient({
      config: this.config,
      timeoutMs: options.timeout ?? this.timeoutMs,
      maxRetries: options.maxRetries ?? this.maxRetries,
      now: this.now,
      sleep: this.sleep,
      fetch: (input, init) =>
        this.fetchImpl(input, {
          ...init,
          headers: mergeHeaders(init?.headers, options.headers),
        }).then((response) => {
          if (response.ok) responseStore.capture(response);
          return response;
        }),
    });
  }
}

export function createVexzySDKAdapter(
  options: VexzySDKAdapterOptions = {},
): VexzySDKAdapter {
  return new VexzySDKAdapter(options);
}

/** Translate the legacy Messages request shape at the final provider boundary. */
export function normalizeVexzyMessageParams(
  params: VexzySDKMessageParams,
): VexzySDKMessageParams {
  const outputConfig = isRecord(params.output_config)
    ? params.output_config
    : undefined;
  const nestedEffort = outputConfig?.effort;
  const reasoningEffort =
    typeof params.reasoning_effort === "string"
      ? params.reasoning_effort
      : typeof nestedEffort === "string"
        ? nestedEffort
        : undefined;

  if (outputConfig === undefined && reasoningEffort === undefined) {
    return params;
  }

  const { effort: _legacyEffort, ...remainingOutputConfig } =
    outputConfig ?? {};
  const { output_config: _legacyOutputConfig, ...remainingParams } = params;

  return {
    ...remainingParams,
    ...(Object.keys(remainingOutputConfig).length > 0 && {
      output_config: remainingOutputConfig,
    }),
    ...(reasoningEffort !== undefined && {
      reasoning_effort: reasoningEffort,
    }),
  };
}

function toNativeOptions(
  options: VexzySDKRequestOptions,
): VexzyMessagesRequestOptions {
  return {
    signal: options.signal ?? undefined,
    timeoutMs: options.timeout,
    maxRetries: options.maxRetries,
  };
}

function decoratePromise<T>(
  value: Promise<T>,
  settled: Promise<VexzySDKResponse<T>>,
): VexzySDKPromise<T> {
  // withResponse()/asResponse() are optional branches. Suppress only their
  // unobserved rejection; callers still receive the same error when awaiting
  // either decorated method or the primary promise.
  void settled.catch(() => {});
  const promise = value as VexzySDKPromise<T>;
  promise.asResponse = async () => (await settled).response;
  promise.withResponse = async () => await settled;
  return promise;
}

function mergeHeaders(
  base: HeadersInit | undefined,
  extra: Readonly<Record<string, string | null | undefined>> | undefined,
): VexzyHeaders {
  const merged = new Headers(base);
  if (extra !== undefined) {
    for (const [name, value] of Object.entries(extra)) {
      if (value === null || value === undefined) merged.delete(name);
      else if (name.toLowerCase() !== "authorization") merged.set(name, value);
    }
  }
  const result: VexzyHeaders = {};
  merged.forEach((value, name) => {
    result[name] = value;
  });
  return result;
}

function isRequestOptions(
  value: Readonly<Record<string, unknown>> | VexzySDKRequestOptions | undefined,
): value is VexzySDKRequestOptions {
  if (value === undefined) return false;
  return (
    "headers" in value ||
    "signal" in value ||
    "timeout" in value ||
    "maxRetries" in value ||
    "betas" in value
  );
}

export function estimateVexzyInputTokens(
  params: Readonly<Record<string, unknown>>,
): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    throw new VexzyMessagesClientError("invalid_request");
  }

  // Vexzy does not document a count_tokens endpoint. Two UTF-8 bytes per
  // token plus a small request-structure allowance is intentionally
  // conservative for code, JSON, prose, and multilingual prompts.
  const bytes = new TextEncoder().encode(serialized).byteLength;
  return Math.max(1, Math.ceil(bytes / 2) + 32);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRequestId(headers: Headers): string | undefined {
  return (
    headers.get("request-id") ??
    headers.get("x-request-id") ??
    headers.get("x-vexzy-request-id") ??
    undefined
  );
}

function normalizeVexzySDKError(error: unknown): Error {
  if (error instanceof VexzyError) return error;
  if (
    error instanceof APIError &&
    !(error instanceof VexzyMessagesClientError) &&
    !(error instanceof VexzyModelClientError)
  ) {
    return error;
  }

  const code = getVexzyClientErrorCode(error);
  switch (code) {
    case "aborted":
      return new APIUserAbortError();
    case "timeout":
      return new APIConnectionTimeoutError();
    case "network":
      return new APIConnectionError({ message: "Vexzy request failed" });
    case "invalid_response":
    case "invalid_request":
      return new APIError(undefined, undefined, errorMessage(error), undefined);
    default:
      return error instanceof Error
        ? error
        : new VexzyBaseError("Vexzy request failed");
  }
}

function getVexzyClientErrorCode(
  error: unknown,
):
  | "aborted"
  | "timeout"
  | "network"
  | "invalid_response"
  | "invalid_request"
  | undefined {
  if (error instanceof VexzyMessagesClientError) return error.code;
  if (error instanceof VexzyModelClientError) return error.code;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Vexzy request failed";
}

function combineSignals(
  parent: AbortSignal | undefined,
  controller: AbortController,
): { signal: AbortSignal; cleanup: () => void } {
  const onAbort = () => controller.abort();
  if (parent?.aborted) controller.abort();
  else parent?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => parent?.removeEventListener("abort", onAbort),
  };
}

function createTimeoutSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; wasTimedOut: () => boolean; cleanup: () => void } {
  const controller = new AbortController();
  const combined = combineSignals(parent, controller);
  let timedOut = false;
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : undefined;
  return {
    signal: combined.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      combined.cleanup();
    },
  };
}

class ResponseStore {
  private readonly byRequestId = new Map<string, Response[]>();
  private readonly withoutRequestId: Response[] = [];

  capture(response: Response): void {
    const requestId = getRequestId(response.headers);
    try {
      const clone = response.clone();
      if (requestId === undefined) {
        this.withoutRequestId.push(clone);
        return;
      }
      let responses = this.byRequestId.get(requestId);
      if (responses === undefined) {
        responses = [];
        this.byRequestId.set(requestId, responses);
      }
      responses.push(clone);
    } catch {
      // A locked body is still representable through the metadata fallback.
    }
  }

  take(metadata: VexzyResponseMetadata): Response {
    const requestId = metadata.requestId;
    if (requestId !== undefined) {
      const responses = this.byRequestId.get(requestId);
      const response = responses?.shift();
      if (responses?.length === 0) this.byRequestId.delete(requestId);
      if (response !== undefined) return response;
    }
    const response = this.withoutRequestId.shift();
    if (response !== undefined) return response;
    return new Response(null, {
      status: metadata.status,
      headers: metadata.headers,
    });
  }
}
