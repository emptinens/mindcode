import { createVexzyRequestInit } from "./auth.js";
import {
  type VexzyConfig,
  createVexzyConfig,
  getVexzyConfig,
} from "./config.js";
import {
  VEXZY_MAX_RETRIES,
  APIError,
  VexzyError,
  VexzyStreamError,
  createVexzyError,
  createVexzyStreamError,
  getVexzyRetryDelayMs,
  markVexzyCompatibilityKind,
  shouldRetryVexzy,
} from "./errors.js";
import {
  type VexzyMessage,
  type VexzyStreamEvent,
  createVexzySseTextParser,
  parseVexzyMessage,
} from "./messagesProtocol.js";
import {
  getVexzyOutputTokenPolicy,
  normalizeVexzyMaxOutputTokens,
} from "../../../utils/context.js";
import { createVexzyRequestSnapshot } from "./requestSnapshot.js";

export const DEFAULT_VEXZY_MESSAGES_TIMEOUT_MS = 600_000;

export type VexzyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type VexzyMessageRole = "user" | "assistant";

export type VexzyMessageContent =
  | string
  | readonly Readonly<Record<string, unknown>>[];

export interface VexzyInputMessage {
  readonly role: VexzyMessageRole;
  readonly content: VexzyMessageContent;
}

export type VexzyReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** Request shape intentionally mirrors Anthropic Messages create params. */
export interface VexzyMessageCreateParams {
  readonly model: string;
  readonly max_tokens: number;
  readonly messages: readonly VexzyInputMessage[];
  readonly system?: string | readonly Readonly<Record<string, unknown>>[];
  readonly reasoning_effort?: VexzyReasoningEffort | (string & {});
  readonly stream?: boolean;
  readonly temperature?: number;
  readonly top_p?: number;
  readonly top_k?: number;
  readonly stop_sequences?: readonly string[];
  readonly tools?: readonly Readonly<Record<string, unknown>>[];
  readonly tool_choice?: Readonly<Record<string, unknown>> | string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface VexzyMessagesRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
}

export interface VexzyResponseMetadata {
  readonly status: number;
  readonly headers: Headers;
  readonly requestId?: string;
}

export interface VexzyMessageWithResponse {
  readonly data: VexzyMessage;
  readonly response: VexzyResponseMetadata;
}

export interface VexzyMessageStream extends AsyncIterable<VexzyStreamEvent> {
  /** Resolves after the response headers are received. */
  readonly response: Promise<VexzyResponseMetadata>;
}

export type VexzyMessagesClientErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "invalid_response"
  | "invalid_request";

export class VexzyMessagesClientError extends APIError {
  readonly code: VexzyMessagesClientErrorCode;

  constructor(code: VexzyMessagesClientErrorCode, cause?: unknown) {
    super(undefined, undefined, getClientErrorMessage(code), undefined);
    this.name = "VexzyMessagesClientError";
    this.code = code;
    if (code === "aborted") markVexzyCompatibilityKind(this, "abort");
    if (code === "timeout") {
      markVexzyCompatibilityKind(this, "timeout");
      markVexzyCompatibilityKind(this, "connection");
    }
    if (code === "network") markVexzyCompatibilityKind(this, "connection");
    if (cause instanceof Error) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: new Error("Vexzy request failed"),
        writable: true,
      });
    }
  }
}

export interface VexzyMessageCreateRequest extends Promise<VexzyMessage> {
  /** Equivalent to the SDK's create(...).withResponse() shape. */
  withResponse(): Promise<VexzyMessageWithResponse>;
}

export interface VexzyMessagesClientOptions {
  readonly apiKey?: string;
  readonly config?: VexzyConfig;
  readonly fetch?: VexzyFetch;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

interface ExecutedResponse {
  readonly response: Response;
  readonly metadata: VexzyResponseMetadata;
}

interface CombinedSignal {
  readonly signal: AbortSignal;
  readonly wasTimedOut: () => boolean;
  cleanup(): void;
}

export class VexzyMessagesClient {
  private readonly config: VexzyConfig;
  private readonly fetchImpl: VexzyFetch;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly now: () => number;
  private readonly sleepImpl: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;

  readonly messages: {
    create: (
      params: VexzyMessageCreateParams,
      options?: VexzyMessagesRequestOptions,
    ) => VexzyMessageCreateRequest;
    createWithResponse: (
      params: VexzyMessageCreateParams,
      options?: VexzyMessagesRequestOptions,
    ) => Promise<VexzyMessageWithResponse>;
    stream: (
      params: VexzyMessageCreateParams,
      options?: VexzyMessagesRequestOptions,
    ) => VexzyMessageStream;
  };

  constructor(options: VexzyMessagesClientOptions = {}) {
    this.config =
      options.config ??
      (options.apiKey === undefined
        ? getVexzyConfig()
        : createVexzyConfig(options.apiKey));
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = validateTimeout(
      options.timeoutMs ?? DEFAULT_VEXZY_MESSAGES_TIMEOUT_MS,
    );
    this.defaultMaxRetries = validateMaxRetries(
      options.maxRetries ?? VEXZY_MAX_RETRIES,
    );
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? sleep;

    this.messages = {
      create: (params, requestOptions) => this.create(params, requestOptions),
      createWithResponse: (params, requestOptions) =>
        this.createWithResponse(params, requestOptions),
      stream: (params, requestOptions) => this.stream(params, requestOptions),
    };
  }

  create(
    params: VexzyMessageCreateParams,
    options: VexzyMessagesRequestOptions = {},
  ): VexzyMessageCreateRequest {
    let pending: Promise<VexzyMessageWithResponse> | undefined;
    const execute = (): Promise<VexzyMessageWithResponse> => {
      pending ??= this.createWithResponse(params, options);
      return pending;
    };

    const request = execute().then(
      (result) => result.data,
    ) as VexzyMessageCreateRequest;
    request.withResponse = execute;
    return request;
  }

  async createWithResponse(
    params: VexzyMessageCreateParams,
    options: VexzyMessagesRequestOptions = {},
  ): Promise<VexzyMessageWithResponse> {
    const combined = createCombinedSignal(
      options.signal,
      validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs),
    );

    try {
      const executed = await this.executeRequest(
        { ...params, stream: false },
        combined.signal,
        validateMaxRetries(options.maxRetries ?? this.defaultMaxRetries),
      );
      if (combined.signal.aborted) {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("aborted");
      }
      let payload: unknown;
      try {
        payload = await executed.response.json();
      } catch {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("invalid_response");
      }

      if (combined.signal.aborted) {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("aborted");
      }

      try {
        return {
          data: parseVexzyMessage(payload),
          response: executed.metadata,
        };
      } catch {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("invalid_response");
      }
    } catch (error) {
      throw this.normalizeError(error, combined);
    } finally {
      combined.cleanup();
    }
  }

  stream(
    params: VexzyMessageCreateParams,
    options: VexzyMessagesRequestOptions = {},
  ): VexzyMessageStream {
    const combined = createCombinedSignal(
      options.signal,
      validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs),
    );
    const execution = this.executeRequest(
      { ...params, stream: true },
      combined.signal,
      validateMaxRetries(options.maxRetries ?? this.defaultMaxRetries),
    ).then(async (executed) => {
      if (combined.signal.aborted) {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("aborted");
      }
      return executed;
    });
    const response = execution.then(
      (executed) => executed.metadata,
      (error) => {
        combined.cleanup();
        throw this.normalizeError(error, combined);
      },
    );
    void response.catch(() => {});

    const iterator = this.readStream(execution, combined);

    return {
      response,
      [Symbol.asyncIterator]: () => iterator,
    };
  }

  private async *readStream(
    execution: Promise<ExecutedResponse>,
    combined: CombinedSignal,
  ): AsyncGenerator<VexzyStreamEvent> {
    let executed: ExecutedResponse | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let completed = false;
    try {
      executed = await execution;
      if (combined.signal.aborted) {
        await cancelResponseBody(executed.response);
        throw new VexzyMessagesClientError("aborted");
      }

      if (executed.response.body === null) {
        throw new VexzyMessagesClientError("invalid_response");
      }

      reader = executed.response.body.getReader();
      const decoder = new TextDecoder();
      const parser = createVexzySseTextParser();

      try {
        while (true) {
          const result = await reader.read();
          if (combined.signal.aborted) {
            throw new VexzyMessagesClientError("aborted");
          }
          if (result.done) break;

          for (const event of parser.push(
            decoder.decode(result.value, { stream: true }),
          )) {
            yield event;
          }
        }

        if (combined.signal.aborted) {
          throw new VexzyMessagesClientError("aborted");
        }
        const finalText = decoder.decode();
        for (const event of parser.push(finalText)) yield event;
        for (const event of parser.finish()) yield event;
      } catch (error) {
        if (error instanceof VexzyMessagesClientError) throw error;
        if (error instanceof APIError) throw error;
        throw createVexzyStreamError(error);
      }

      completed = true;
    } catch (error) {
      const normalized = this.normalizeError(error, combined);
      throw normalized;
    } finally {
      if (reader !== undefined) {
        if (!completed) {
          try {
            await reader.cancel();
          } catch {
            // The stream is already errored or canceled.
          }
        }
        reader.releaseLock();
      } else if (executed !== undefined && !completed) {
        await cancelResponseBody(executed.response);
      }
      combined.cleanup();
    }
  }

  private async executeRequest(
    params: VexzyMessageCreateParams,
    signal: AbortSignal,
    maxRetries: number,
  ): Promise<ExecutedResponse> {
    if (signal.aborted) throw new VexzyMessagesClientError("aborted");

    let body: string;
    try {
      const policy = getVexzyOutputTokenPolicy(params.model);
      const max_tokens = normalizeVexzyMaxOutputTokens(
        params.max_tokens,
        policy.maxOutputTokens,
        policy.maxOutputTokens,
        true,
      ).value;
      const snapshot = createVexzyRequestSnapshot({
        ...params,
        max_tokens,
      });
      body = JSON.stringify(snapshot.params);
    } catch {
      throw new VexzyMessagesClientError("invalid_request");
    }

    let retryCount = 0;
    while (true) {
      if (signal.aborted) throw new VexzyMessagesClientError("aborted");

      let response: Response;
      try {
        response = await this.fetchImpl(
          this.config.endpoints.messages,
          createVexzyRequestInit(this.config.apiKey, {
            method: "POST",
            headers: {
              Accept: "application/json, text/event-stream",
              "Content-Type": "application/json",
            },
            body,
            signal,
          }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new VexzyMessagesClientError("network", error);
      }

      if (signal.aborted) {
        await cancelResponseBody(response);
        throw new VexzyMessagesClientError("aborted");
      }

      if (response.ok) {
        return { response, metadata: getResponseMetadata(response) };
      }

      const error = createVexzyError(response, this.now());
      await cancelResponseBody(response);
      if (
        retryCount < maxRetries &&
        shouldRetryVexzy(error, retryCount)
      ) {
        await this.sleepImpl(getVexzyRetryDelayMs(error, retryCount), signal);
        if (signal.aborted) {
          throw new VexzyMessagesClientError("aborted");
        }
        retryCount += 1;
        continue;
      }

      throw error;
    }
  }

  private normalizeError(error: unknown, combined: CombinedSignal): Error {
    if (combined.signal.aborted) {
      return new VexzyMessagesClientError(
        combined.wasTimedOut() ? "timeout" : "aborted",
      );
    }
    if (error instanceof VexzyError) return error;
    if (error instanceof VexzyMessagesClientError) return error;
    if (error instanceof VexzyStreamError) return error;
    if (error instanceof APIError) return error;
    return new VexzyMessagesClientError("network");
  }
}

export function createVexzyMessagesClient(
  options: VexzyMessagesClientOptions = {},
): VexzyMessagesClient {
  return new VexzyMessagesClient(options);
}

function getResponseMetadata(response: Response): VexzyResponseMetadata {
  const headers = new Headers(response.headers);
  const requestId =
    headers.get("request-id") ??
    headers.get("x-request-id") ??
    headers.get("x-vexzy-request-id") ??
    undefined;

  return {
    status: response.status,
    headers,
    ...(requestId !== undefined && { requestId }),
  };
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Body cleanup must not replace the request or response error.
  }
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Vexzy Messages timeout must be a non-negative number");
  }
  return timeoutMs;
}

function validateMaxRetries(maxRetries: number): number {
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new TypeError(
      "Vexzy Messages maxRetries must be a non-negative integer",
    );
  }
  return maxRetries;
}

function getClientErrorMessage(code: VexzyMessagesClientErrorCode): string {
  switch (code) {
    case "aborted":
      return "Vexzy Messages request was aborted";
    case "timeout":
      return "Vexzy Messages request timed out";
    case "network":
      return "Vexzy Messages request failed";
    case "invalid_response":
      return "Vexzy Messages response was invalid";
    case "invalid_request":
      return "Vexzy Messages request was invalid";
  }
}

function createCombinedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): CombinedSignal {
  const controller = new AbortController();
  let timedOut = false;
  let parentAborted = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    parentAborted = true;
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  };
  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (!controller.signal.aborted && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (parentAborted || controller.signal.aborted) return;
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal.aborted) throw new VexzyMessagesClientError("aborted");
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timerRef: {
      id: ReturnType<typeof setTimeout> | undefined;
    } = { id: undefined };
    const cleanup = () => {
      if (timerRef.id !== undefined) clearTimeout(timerRef.id);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new VexzyMessagesClientError("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    timerRef.id = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}
