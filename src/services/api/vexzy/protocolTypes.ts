/**
 * Local structural types for the VEXZY Anthropic-compatible Messages protocol.
 *
 * Runtime/core code imports these types instead of coupling its type graph to
 * an SDK package. The shapes intentionally describe only fields consumed by
 * MindCode and fields accepted/returned by VEXZY /v1/messages.
 */

import type { VexzyMessage, VexzyStreamEvent } from "./messagesProtocol.js";

export type JsonObject = { [key: string]: unknown };

export interface CacheControlEphemeral {
  type: "ephemeral";
  scope?: "global" | "org";
  ttl?: "5m" | "1h";
}

export interface Base64ImageSource {
  data: string;
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  type: "base64";
}

export interface URLImageSource {
  type: "url";
  url: string;
}

export type ImageSource = Base64ImageSource | URLImageSource;

export interface CitationsConfigParam {
  enabled?: boolean;
}

export interface CitationCharLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_char_index: number;
  start_char_index: number;
  type: "char_location";
}

export interface CitationPageLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_page_number: number;
  start_page_number: number;
  type: "page_location";
}

export interface CitationContentBlockLocation {
  cited_text: string;
  document_index: number;
  document_title: string | null;
  end_block_index: number;
  start_block_index: number;
  type: "content_block_location";
}

export type TextCitationParam =
  | CitationCharLocation
  | CitationPageLocation
  | CitationContentBlockLocation;

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: CacheControlEphemeral | null;
  citations?: TextCitationParam[] | null;
}

export interface ImageBlockParam {
  type: "image";
  source: ImageSource;
  cache_control?: CacheControlEphemeral | null;
}

export interface Base64PDFSource {
  data: string;
  media_type: "application/pdf";
  type: "base64";
}

export interface URLPDFSource {
  type: "url";
  url: string;
}

export interface PlainTextSource {
  data: string;
  media_type: "text/plain";
  type: "text";
}

export interface ContentBlockSource {
  content: string | (TextBlockParam | ImageBlockParam)[];
  type: "content";
}

export interface DocumentBlockParam {
  type: "document";
  source:
    | Base64PDFSource
    | URLPDFSource
    | PlainTextSource
    | ContentBlockSource;
  cache_control?: CacheControlEphemeral | null;
  citations?: CitationsConfigParam;
  context?: string | null;
  title?: string | null;
}

export interface ThinkingBlockParam {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlockParam {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseBlockParam {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
  cache_control?: CacheControlEphemeral | null;
}

export interface ToolResultBlockParam {
  type: "tool_result";
  tool_use_id: string;
  content?: string | (TextBlockParam | ImageBlockParam)[];
  is_error?: boolean;
  cache_control?: CacheControlEphemeral | null;
}

export interface ProviderContentBlockParam extends JsonObject {
  type:
    | "code_execution_tool_result"
    | "mcp_tool_use"
    | "mcp_tool_result"
    | "container_upload";
  text?: string;
  input?: unknown;
}

export type ContentBlockParam =
  | TextBlockParam
  | ProviderContentBlockParam
  | ImageBlockParam
  | DocumentBlockParam
  | ThinkingBlockParam
  | RedactedThinkingBlockParam
  | ToolUseBlockParam
  | ToolResultBlockParam;

export interface MessageParam {
  role: "user" | "assistant";
  content: string | ContentBlockParam[];
}

export type BetaMessageParam = MessageParam;

export interface TextBlock {
  type: "text";
  text: string;
  citations?: TextCitationParam[] | null;
}

export interface ImageBlock {
  type: "image";
  source: ImageSource;
}

export interface DocumentBlock {
  type: "document";
  source:
    | Base64PDFSource
    | URLPDFSource
    | PlainTextSource
    | ContentBlockSource;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ServerToolUseBlock {
  type: "server_tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
}

export interface FutureContentBlock extends JsonObject {
  type: string;
}

export interface ProviderContentBlock extends JsonObject {
  type:
    | "code_execution_tool_result"
    | "mcp_tool_use"
    | "mcp_tool_result"
    | "container_upload";
  text?: string;
  input?: unknown;
}

export type ContentBlock =
  | TextBlock
  | ImageBlock
  | DocumentBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | ToolResultBlock;

export type BetaContentBlock = ContentBlock;
export type BetaContentBlockParam = ContentBlockParam;
export type BetaTextBlockParam = TextBlockParam;
export type BetaImageBlockParam = ImageBlockParam;
export type BetaToolUseBlockParam = ToolUseBlockParam;
export type BetaToolResultBlockParam = ToolResultBlockParam;
export type BetaToolUseBlock = ToolUseBlock;

export type BetaRedactedThinkingBlock = RedactedThinkingBlock;
export type BetaThinkingBlock = ThinkingBlock;

export interface BetaUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  } | null;
  service_tier?: string | null;
  speed?: string | null;
  [key: string]: unknown;
}

export type Usage = BetaUsage;

export type BetaStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "pause_turn"
  | "refusal"
  | (string & {});

export interface BetaMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: BetaContentBlock[];
  stop_reason: BetaStopReason | null;
  stop_sequence: string | null;
  usage: BetaUsage;
}

export interface BetaMessageDeltaUsage {
  output_tokens: number;
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: {
    ephemeral_1h_input_tokens?: number;
    ephemeral_5m_input_tokens?: number;
  };
  server_tool_use?: {
    web_search_requests?: number;
    web_fetch_requests?: number;
  } | null;
  service_tier?: string | null;
  speed?: string | null;
  iterations?: unknown;
  [key: string]: unknown;
}

export interface BetaToolInputSchema extends JsonObject {
  type: "object";
  properties?: unknown | null;
}

export interface Tool {
  name: string;
  description?: string;
  input_schema: BetaToolInputSchema;
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaTool extends Tool {
  type?: "custom" | null;
  strict?: boolean;
  defer_loading?: boolean;
  eager_input_streaming?: boolean;
  [key: string]: unknown;
}

export interface BetaToolBash20241022 {
  name: "bash";
  type: "bash_20241022";
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaToolBash20250124 {
  name: "bash";
  type: "bash_20250124";
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaToolTextEditor20241022 {
  name: "str_replace_editor";
  type: "text_editor_20241022";
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaToolTextEditor20250124 {
  name: "str_replace_editor";
  type: "text_editor_20250124";
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaToolComputerUse20241022 {
  name: "computer";
  type: "computer_20241022";
  display_height_px: number;
  display_width_px: number;
  display_number?: number | null;
  cache_control?: CacheControlEphemeral | null;
}

export interface BetaToolComputerUse20250124 {
  name: "computer";
  type: "computer_20250124";
  display_height_px: number;
  display_width_px: number;
  display_number?: number | null;
  cache_control?: CacheControlEphemeral | null;
}

export type BetaToolUnion =
  | BetaTool
  | BetaToolBash20241022
  | BetaToolBash20250124
  | BetaToolTextEditor20241022
  | BetaToolTextEditor20250124
  | BetaToolComputerUse20241022
  | BetaToolComputerUse20250124;

export type ToolUnion = BetaToolUnion;

export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type VexzyReasoningEffort = ReasoningEffort;

export type BetaToolChoice = ToolChoice;

export type BetaToolChoiceAny = ToolChoiceAny;
export type BetaToolChoiceNone = ToolChoiceNone;

export type BetaToolChoiceAuto = ToolChoiceAuto;
export type BetaToolChoiceTool = ToolChoiceTool;

export type BetaContentBlockSource = ContentBlockSource;
export type BetaCitationsConfigParam = CitationsConfigParam;

export type BetaBase64PDFBlock = DocumentBlockParam;

export interface ToolChoiceAuto {
  type: "auto";
  disable_parallel_tool_use?: boolean;
}

export interface ToolChoiceAny {
  type: "any";
  disable_parallel_tool_use?: boolean;
}

export interface ToolChoiceTool {
  type: "tool";
  name: string;
  disable_parallel_tool_use?: boolean;
}

export interface ToolChoiceNone {
  type: "none";
}

export type ToolChoice =
  | ToolChoiceAuto
  | ToolChoiceAny
  | ToolChoiceTool
  | ToolChoiceNone;

export interface BetaJSONOutputFormat {
  type: "json_schema";
  schema?: JsonObject;
  name?: string;
  description?: string;
}

export type BetaThinkingConfigParam =
  | { type: "enabled"; budget_tokens: number }
  | { type: "disabled" }
  | { type: "adaptive" };

export interface BetaOutputConfig {
  format?: BetaJSONOutputFormat;
  effort?:
    | "none"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max"
    | "auto";
  [key: string]: unknown;
}

export interface BetaRequestDocumentBlock extends DocumentBlockParam {}

export interface BetaMessageStreamParams {
  model: string;
  max_tokens: number;
  messages: BetaMessageParam[];
  system?: string | TextBlockParam[];
  tools?: BetaToolUnion[];
  tool_choice?: ToolChoice;
  thinking?: BetaThinkingConfigParam;
  output_config?: BetaOutputConfig;
  metadata?: JsonObject;
  stream?: boolean;
  reasoning_effort?: ReasoningEffort;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  speed?: string;
  [key: string]: unknown;
}

export interface BetaRawMessageStartEvent {
  type: "message_start";
  message: BetaMessage;
}

export interface BetaRawContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export type BetaRawContentBlockDelta =
  | { type: "text_delta"; text: string }
  | { type: "input_json_delta"; partial_json: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "signature_delta"; signature: string }
  | { type: "citations_delta"; citation: JsonObject };

export interface BetaRawContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: BetaRawContentBlockDelta;
}

export interface BetaRawContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface BetaRawMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: BetaStopReason | null; stop_sequence: string | null };
  usage: BetaMessageDeltaUsage;
}

export interface BetaRawMessageStopEvent {
  type: "message_stop";
}

export interface BetaRawPingEvent {
  type: "ping";
}

export type BetaRawMessageStreamEvent =
  | BetaRawMessageStartEvent
  | BetaRawContentBlockStartEvent
  | BetaRawContentBlockDeltaEvent
  | BetaRawContentBlockStopEvent
  | BetaRawMessageDeltaEvent
  | BetaRawMessageStopEvent
  | BetaRawPingEvent;

export interface VexzyClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string | null;
  authToken?: string | null;
  baseURL?: string | null;
  timeout?: number;
  maxRetries?: number;
}

export interface VexzyStream<T> extends AsyncIterable<T> {
  controller: AbortController;
  response: Promise<Response>;
  request_id: Promise<string | null | undefined>;
  aborted: boolean;
  next(...args: [] | [undefined]): Promise<IteratorResult<T>>;
  return?(value?: unknown): Promise<IteratorResult<T>>;
  abort(): void;
}

export interface VexzyClient {
  messages: {
    create(
      params: BetaMessageStreamParams & { stream: true },
      options?: VexzyRequestOptions,
    ): VexzyPromise<VexzyStream<BetaRawMessageStreamEvent>>;
    create(
      params: BetaMessageStreamParams & { stream?: false },
      options?: VexzyRequestOptions,
    ): VexzyPromise<BetaMessage>;
    create(
      params: BetaMessageStreamParams,
      options?: VexzyRequestOptions,
    ): VexzyPromise<BetaMessage | VexzyStream<BetaRawMessageStreamEvent>>;
    stream(
      params: BetaMessageStreamParams,
      options?: VexzyRequestOptions,
    ): VexzyStream<BetaRawMessageStreamEvent>;
    countTokens(
      params: Readonly<Record<string, unknown>>,
      options?: VexzyRequestOptions,
    ): VexzyPromise<{ input_tokens: number }>;
  };
  beta: {
    messages: VexzyClient["messages"];
  };
  models?: {
    list: (...args: unknown[]) => Promise<unknown>;
  };
}

export interface VexzyRequestOptions {
  headers?: Readonly<Record<string, string | null | undefined>>;
  signal?: AbortSignal | null;
  timeout?: number;
  maxRetries?: number;
  betas?: string[];
  [key: string]: unknown;
}

export interface VexzyPromise<T> extends Promise<T> {
  asResponse(): Promise<Response>;
  withResponse(): Promise<{
    data: T;
    response: Response;
    request_id?: string | null;
  }>;
}

export type ToolInputSchema = BetaToolInputSchema;
export type StreamEvent = VexzyStreamEvent;
export type VexzyMessageResponse = VexzyMessage;
