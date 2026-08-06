/**
 * Provider-neutral model transport contracts.
 *
 * This module intentionally contains only domain terminology. Provider
 * protocol translation belongs in an adapter under services/api/<provider>.
 */

export type TransportJsonPrimitive = string | number | boolean | null;
export type TransportJsonValue =
  | TransportJsonPrimitive
  | { readonly [key: string]: TransportJsonValue }
  | readonly TransportJsonValue[];

export type TransportContentBlock = Readonly<Record<string, unknown>>;

export interface TransportMessage {
  readonly role: "user" | "assistant";
  readonly content: string | readonly TransportContentBlock[];
}

export interface TransportToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type TransportToolChoice =
  | { readonly kind: "auto" }
  | { readonly kind: "any" }
  | { readonly kind: "tool"; readonly name: string };

export interface TransportOutputFormat {
  readonly type: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface TransportRequest {
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly messages: readonly TransportMessage[];
  readonly system?: string | readonly TransportContentBlock[];
  readonly reasoningEffort?: string;
  readonly temperature?: number;
  readonly topP?: number;
  readonly topK?: number;
  readonly stopSequences?: readonly string[];
  readonly tools?: readonly TransportToolDefinition[];
  readonly toolChoice?: TransportToolChoice;
  readonly metadata?: Readonly<Record<string, TransportJsonValue>>;
  readonly outputFormat?: TransportOutputFormat;
}

export interface TransportRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly headers?: Readonly<Record<string, string>>;
}

export interface TransportResponseMetadata {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId?: string;
}

export interface TransportUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheWriteInputTokens?: number;
}

export interface TransportResponse {
  readonly id: string;
  readonly model: string;
  readonly content: readonly TransportContentBlock[];
  readonly stopReason: string | null;
  readonly usage: TransportUsage;
}

export interface TransportResult {
  readonly data: TransportResponse;
  readonly response: TransportResponseMetadata;
}

export interface TransportTokenCount {
  readonly inputTokens: number;
}

export interface TransportModelInfo {
  readonly id: string;
  readonly displayName: string;
  readonly available?: boolean;
  readonly contextLength?: number;
  readonly maxOutputTokens?: number;
  readonly reasoningEfforts?: readonly string[];
}

export type TransportStreamEvent =
  | {
      readonly kind: "started";
      readonly response: Pick<TransportResponse, "id" | "model">;
    }
  | {
      readonly kind: "content_started";
      readonly index: number;
      readonly content: TransportContentBlock;
    }
  | {
      readonly kind: "content_delta";
      readonly index: number;
      readonly delta: Readonly<Record<string, unknown>>;
    }
  | { readonly kind: "content_stopped"; readonly index: number }
  | { readonly kind: "keepalive" }
  | {
      readonly kind: "completed";
      readonly stopReason: string | null;
      readonly usage: Partial<TransportUsage>;
    };

export interface TransportStream extends AsyncIterable<TransportStreamEvent> {
  readonly response: Promise<TransportResponseMetadata>;
  readonly aborted: boolean;
  abort(): void;
}

export interface ModelTransport {
  complete(
    request: TransportRequest,
    options?: TransportRequestOptions,
  ): Promise<TransportResult>;
  stream(
    request: TransportRequest,
    options?: TransportRequestOptions,
  ): TransportStream;
  countInputTokens(
    request: TransportRequest,
    options?: TransportRequestOptions,
  ): Promise<TransportTokenCount>;
  listModels(
    options?: TransportRequestOptions,
  ): Promise<readonly TransportModelInfo[]>;
}

export type ModelTransportErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "invalid_request"
  | "invalid_response"
  | "request_failed";

export class ModelTransportError extends Error {
  readonly code: ModelTransportErrorCode;
  readonly status?: number;

  constructor(code: ModelTransportErrorCode, status?: number) {
    super(`Model transport request ${code.replace("_", " ")}`);
    this.name = "ModelTransportError";
    this.code = code;
    this.status = status;
  }
}
