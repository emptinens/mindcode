import { decode, encode } from "@msgpack/msgpack";

export const NATIVE_TUI_PROTOCOL_VERSION = 2 as const;
export const NATIVE_TUI_MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const NATIVE_TUI_MAX_ID_BYTES = 128;
export const NATIVE_TUI_MAX_CLIENT_BYTES = 128;
export const NATIVE_TUI_MAX_CAPABILITIES = 64;
export const NATIVE_TUI_MAX_CAPABILITY_BYTES = 128;
export const NATIVE_TUI_MAX_INPUT_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_INPUT_MODIFIERS = 8;
export const NATIVE_TUI_MAX_STATUS_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_TASKS = 1_024;
export const NATIVE_TUI_MAX_TASK_ID_BYTES = 256;
export const NATIVE_TUI_MAX_TASK_TITLE_BYTES = 4 * 1024;
export const NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES = 4_096;
export const NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES = 64;
export const NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_SNAPSHOT_BYTES = 3 * 1024 * 1024;
export const NATIVE_TUI_MAX_CODE_BYTES = 128;
export const NATIVE_TUI_MAX_MESSAGE_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_REASON_BYTES = 4 * 1024;
export const NATIVE_TUI_MAX_SESSIONS = 256;
export const NATIVE_TUI_MAX_SESSION_NAME_BYTES = 256;
export const NATIVE_TUI_MAX_WORKSPACES = 128;
export const NATIVE_TUI_MAX_WORKSPACE_BYTES = 1_024;
export const NATIVE_TUI_MAX_MODEL_BYTES = 128;
export const NATIVE_TUI_MAX_EFFORT_BYTES = 16;
export const NATIVE_TUI_MAX_CONNECTION_BYTES = 64;
export const NATIVE_TUI_MAX_AGENTS = 256;
export const NATIVE_TUI_MAX_AGENT_ID_BYTES = 256;
export const NATIVE_TUI_MAX_AGENT_NAME_BYTES = 256;
export const NATIVE_TUI_MAX_DEPENDENCIES = 128;
export const NATIVE_TUI_MAX_FILES = 4_096;
export const NATIVE_TUI_MAX_FILE_PATH_BYTES = 2_048;
export const NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS = 8_192;
export const NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES = 256;
export const NATIVE_TUI_MAX_LANGUAGE_BYTES = 64;
export const NATIVE_TUI_MAX_TOOL_NAME_BYTES = 128;
export const NATIVE_TUI_MAX_TOOL_ARGUMENTS_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_REPORT_EVIDENCE = 256;
export const NATIVE_TUI_MAX_REPORT_EVIDENCE_BYTES = 2_048;
export const NATIVE_TUI_MAX_DIFF_BYTES = 256 * 1024;
export const NATIVE_TUI_MAX_ACTIVITY = 4_096;
export const NATIVE_TUI_MAX_ACTIVITY_ID_BYTES = 256;
export const NATIVE_TUI_MAX_ACTIVITY_MESSAGE_BYTES = 4 * 1024;
export const NATIVE_TUI_MAX_PERMISSIONS = 256;
export const NATIVE_TUI_MAX_PERMISSION_ID_BYTES = 256;
export const NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES = 4 * 1024;
export const NATIVE_TUI_MAX_WRITERS = 64;
export const NATIVE_TUI_MAX_ACTION_BYTES = 128;
export const NATIVE_TUI_MAX_ACTION_VALUE_BYTES = 64 * 1024;
export const NATIVE_TUI_MAX_PENDING_INPUTS = 256;

export const UI_MAX_FRAME_SIZE = NATIVE_TUI_MAX_FRAME_BYTES;
export const UI_MAX_ID_BYTES = NATIVE_TUI_MAX_ID_BYTES;
export const UI_MAX_CLIENT_BYTES = NATIVE_TUI_MAX_CLIENT_BYTES;
export const UI_MAX_CAPABILITIES = NATIVE_TUI_MAX_CAPABILITIES;
export const UI_MAX_CAPABILITY_BYTES = NATIVE_TUI_MAX_CAPABILITY_BYTES;
export const UI_MAX_INPUT_BYTES = NATIVE_TUI_MAX_INPUT_BYTES;
export const UI_MAX_INPUT_MODIFIERS = NATIVE_TUI_MAX_INPUT_MODIFIERS;
export const UI_MAX_STATUS_BYTES = NATIVE_TUI_MAX_STATUS_BYTES;
export const UI_MAX_TASKS = NATIVE_TUI_MAX_TASKS;
export const UI_MAX_TASK_ID_BYTES = NATIVE_TUI_MAX_TASK_ID_BYTES;
export const UI_MAX_TASK_TITLE_BYTES = NATIVE_TUI_MAX_TASK_TITLE_BYTES;
export const UI_MAX_TRANSCRIPT_ENTRIES = NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES;
export const UI_MAX_TRANSCRIPT_ROLE_BYTES = NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES;
export const UI_MAX_TRANSCRIPT_TEXT_BYTES = NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES;
export const UI_MAX_SNAPSHOT_BYTES = NATIVE_TUI_MAX_SNAPSHOT_BYTES;
export const UI_MAX_CODE_BYTES = NATIVE_TUI_MAX_CODE_BYTES;
export const UI_MAX_MESSAGE_BYTES = NATIVE_TUI_MAX_MESSAGE_BYTES;
export const UI_MAX_REASON_BYTES = NATIVE_TUI_MAX_REASON_BYTES;
export const UI_MAX_PENDING_INPUTS = NATIVE_TUI_MAX_PENDING_INPUTS;
export const UI_MAX_SESSIONS = NATIVE_TUI_MAX_SESSIONS;
export const UI_MAX_SESSION_NAME_BYTES = NATIVE_TUI_MAX_SESSION_NAME_BYTES;
export const UI_MAX_WORKSPACES = NATIVE_TUI_MAX_WORKSPACES;
export const UI_MAX_WORKSPACE_BYTES = NATIVE_TUI_MAX_WORKSPACE_BYTES;
export const UI_MAX_MODEL_BYTES = NATIVE_TUI_MAX_MODEL_BYTES;
export const UI_MAX_EFFORT_BYTES = NATIVE_TUI_MAX_EFFORT_BYTES;
export const UI_MAX_CONNECTION_BYTES = NATIVE_TUI_MAX_CONNECTION_BYTES;
export const UI_MAX_AGENTS = NATIVE_TUI_MAX_AGENTS;
export const UI_MAX_AGENT_ID_BYTES = NATIVE_TUI_MAX_AGENT_ID_BYTES;
export const UI_MAX_AGENT_NAME_BYTES = NATIVE_TUI_MAX_AGENT_NAME_BYTES;
export const UI_MAX_DEPENDENCIES = NATIVE_TUI_MAX_DEPENDENCIES;
export const UI_MAX_FILES = NATIVE_TUI_MAX_FILES;
export const UI_MAX_FILE_PATH_BYTES = NATIVE_TUI_MAX_FILE_PATH_BYTES;
export const UI_MAX_TRANSCRIPT_BLOCKS = NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS;
export const UI_MAX_TRANSCRIPT_ID_BYTES = NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES;
export const UI_MAX_LANGUAGE_BYTES = NATIVE_TUI_MAX_LANGUAGE_BYTES;
export const UI_MAX_TOOL_NAME_BYTES = NATIVE_TUI_MAX_TOOL_NAME_BYTES;
export const UI_MAX_TOOL_ARGUMENTS_BYTES = NATIVE_TUI_MAX_TOOL_ARGUMENTS_BYTES;
export const UI_MAX_TOOL_OUTPUT_BYTES = NATIVE_TUI_MAX_TOOL_OUTPUT_BYTES;
export const UI_MAX_REPORT_EVIDENCE = NATIVE_TUI_MAX_REPORT_EVIDENCE;
export const UI_MAX_REPORT_EVIDENCE_BYTES = NATIVE_TUI_MAX_REPORT_EVIDENCE_BYTES;
export const UI_MAX_DIFF_BYTES = NATIVE_TUI_MAX_DIFF_BYTES;
export const UI_MAX_ACTIVITY = NATIVE_TUI_MAX_ACTIVITY;
export const UI_MAX_ACTIVITY_ID_BYTES = NATIVE_TUI_MAX_ACTIVITY_ID_BYTES;
export const UI_MAX_ACTIVITY_MESSAGE_BYTES = NATIVE_TUI_MAX_ACTIVITY_MESSAGE_BYTES;
export const UI_MAX_PERMISSIONS = NATIVE_TUI_MAX_PERMISSIONS;
export const UI_MAX_PERMISSION_ID_BYTES = NATIVE_TUI_MAX_PERMISSION_ID_BYTES;
export const UI_MAX_PERMISSION_TEXT_BYTES = NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES;
export const UI_MAX_WRITERS = NATIVE_TUI_MAX_WRITERS;
export const UI_MAX_ACTION_BYTES = NATIVE_TUI_MAX_ACTION_BYTES;
export const UI_MAX_ACTION_VALUE_BYTES = NATIVE_TUI_MAX_ACTION_VALUE_BYTES;

export type NativeTuiHandshake = {
  type: "handshake";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  client: string;
  capabilities: string[];
};

export type NativeTuiCapabilities = {
  type: "capabilities";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  capabilities: string[];
};

export type NativeTuiTerminalSize = {
  type: "terminal_size";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  columns: number;
  rows: number;
};

export type NativeTuiMouseButton =
  | "none"
  | "left"
  | "middle"
  | "right"
  | "other";

export type NativeTuiMouseEventKind =
  | "move"
  | "down"
  | "up"
  | "drag"
  | "scroll_up"
  | "scroll_down";

export type NativeTuiKeyInput = {
  type: "key";
  key: string;
  modifiers: string[];
};

export type NativeTuiMouseInput = {
  type: "mouse";
  x: number;
  y: number;
  button: NativeTuiMouseButton;
  kind: NativeTuiMouseEventKind;
  modifiers: string[];
};

export type NativeTuiActionInput = {
  type: "action";
  action: string;
  target?: string;
  value?: string;
};

export type NativeTuiInputEventKind =
  | NativeTuiKeyInput
  | NativeTuiMouseInput
  | NativeTuiActionInput
  | { type: "text"; text: string }
  | { type: "paste"; text: string }
  | { type: "submit" }
  | { type: "cancel" }
  | { type: "interrupt" };

export type NativeTuiInputEvent = {
  type: "input_event";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  event: NativeTuiInputEventKind;
};

export type NativeTuiStatusSnapshot = {
  state: string;
  message?: string;
  detail?: string;
};

export type NativeTuiConnectionSnapshot = {
  state: string;
  reconnect_attempts: number;
  last_error?: string;
};

export type NativeTuiTelemetrySnapshot = {
  connection: NativeTuiConnectionSnapshot;
  model: string;
  effort: string;
  context_used_tokens: number;
  context_limit_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  reasoning_tokens: number;
  credits: number;
  active_agents: number;
  queued_tasks: number;
  api_requests: number;
  latency_ms: number;
};

export type NativeTuiWorkspaceSnapshot = {
  id: string;
  name: string;
  path: string;
  active: boolean;
};

export type NativeTuiSessionSnapshot = {
  id: string;
  name: string;
  workspace: string;
  status: string;
  model: string;
  effort: string;
  active: boolean;
  pinned: boolean;
  unread: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type NativeTuiTaskMetadata = {
  parent_id?: string;
  owner?: string;
  agent_id?: string;
  model?: string;
  effort?: string;
  dependencies: string[];
  blocked_by: string[];
  files_touched: string[];
  isolation?: string;
};

export type NativeTuiTaskSnapshot = {
  id: string;
  title: string;
  status: string;
  detail?: string;
  progress?: number;
  metadata: NativeTuiTaskMetadata;
};

export type NativeTuiAgentSnapshot = {
  id: string;
  name: string;
  role: string;
  status: string;
  parent_id?: string;
  task_id?: string;
  model: string;
  effort: string;
  progress?: number;
};

export type NativeTuiTranscriptEntry = {
  sequence: number;
  role: string;
  text: string;
};

export type NativeTuiMarkdownBlock = {
  type: "markdown";
  id: string;
  sequence: number;
  role: string;
  text: string;
  created_at_ms?: number;
};

export type NativeTuiCodeBlock = {
  type: "code";
  id: string;
  sequence: number;
  role: string;
  language: string;
  code: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
};

export type NativeTuiToolBlock = {
  type: "tool";
  id: string;
  sequence: number;
  name: string;
  status: string;
  input?: string;
  output?: string;
  duration_ms?: number;
};

export type NativeTuiThinkingBlock = {
  type: "thinking";
  id: string;
  sequence: number;
  summary: string;
  effort: string;
  elapsed_ms: number;
  tokens_used: number;
};

export type NativeTuiReportBlock = {
  type: "report";
  id: string;
  sequence: number;
  task_id: string;
  status: string;
  summary: string;
  changed_files: string[];
  evidence: string[];
  tokens_used: number;
  effort_used: string;
};

export type NativeTuiErrorBlock = {
  type: "error";
  id: string;
  sequence: number;
  code: string;
  message: string;
  detail?: string;
  recoverable: boolean;
};

export type NativeTuiTranscriptBlock =
  | NativeTuiMarkdownBlock
  | NativeTuiCodeBlock
  | NativeTuiToolBlock
  | NativeTuiThinkingBlock
  | NativeTuiReportBlock
  | NativeTuiErrorBlock;

export type NativeTuiTranscriptWindow = {
  start_sequence: number;
  end_sequence: number;
  has_older: boolean;
  has_newer: boolean;
  blocks: NativeTuiTranscriptBlock[];
};

export type NativeTuiChangeSnapshot = {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
  staged: boolean;
  language?: string;
  diff?: string;
};

export type NativeTuiActivitySnapshot = {
  id: string;
  timestamp_ms: number;
  kind: string;
  message: string;
  task_id?: string;
  agent_id?: string;
  severity: string;
};

export type NativeTuiPermissionRequest = {
  id: string;
  tool: string;
  action: string;
  resource: string;
  reason: string;
  status: string;
  requested_at_ms: number;
  expires_at_ms?: number;
  task_id?: string;
  agent_id?: string;
};

export type NativeTuiWriterState = {
  mode: string;
  writer_id?: string;
  lease_expires_at_ms?: number;
  observers: string[];
};

export type NativeTuiRenderSnapshot = {
  type: "render_snapshot";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  sessions: NativeTuiSessionSnapshot[];
  workspaces: NativeTuiWorkspaceSnapshot[];
  active_session_id?: string;
  status: NativeTuiStatusSnapshot;
  telemetry: NativeTuiTelemetrySnapshot;
  tasks: NativeTuiTaskSnapshot[];
  agents: NativeTuiAgentSnapshot[];
  transcript: NativeTuiTranscriptBlock[];
  transcript_window?: NativeTuiTranscriptWindow;
  changes: NativeTuiChangeSnapshot[];
  activity: NativeTuiActivitySnapshot[];
  permissions: NativeTuiPermissionRequest[];
  writer: NativeTuiWriterState;
};

export type NativeTuiAck = {
  type: "ack";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  sequence: number;
};

export type NativeTuiError = {
  type: "error";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  code: string;
  message: string;
  details?: string;
};

export type NativeTuiShutdown = {
  type: "shutdown";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  reason?: string;
};

export type NativeTuiWireMessage =
  | NativeTuiHandshake
  | NativeTuiCapabilities
  | NativeTuiTerminalSize
  | NativeTuiInputEvent
  | NativeTuiRenderSnapshot
  | NativeTuiAck
  | NativeTuiError
  | NativeTuiShutdown;

export type NativeTuiClientMessage =
  | NativeTuiHandshake
  | NativeTuiCapabilities
  | NativeTuiTerminalSize
  | NativeTuiInputEvent
  | NativeTuiShutdown;

export type NativeTuiServerMessage =
  | NativeTuiCapabilities
  | NativeTuiRenderSnapshot
  | NativeTuiAck
  | NativeTuiError
  | NativeTuiShutdown;

export type UiMessage = NativeTuiWireMessage;
export type UiWireMessage = NativeTuiWireMessage;
export type UiClientMessage = NativeTuiClientMessage;
export type UiServerMessage = NativeTuiServerMessage;

export class NativeTuiProtocolError extends Error {
  readonly code = "NATIVE_TUI_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "NativeTuiProtocolError";
  }
}

const textEncoder = new TextEncoder();

export function encodeNativeTuiFrame(
  message: NativeTuiWireMessage,
  maxFrameBytes = NATIVE_TUI_MAX_FRAME_BYTES,
): Buffer {
  const frameLimit = boundedFrameLimit(maxFrameBytes);
  validateNativeTuiMessage(message);
  let payload: Uint8Array;
  try {
    payload = encode(message);
  } catch (error) {
    throw protocol(
      `MessagePack encoding failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (payload.byteLength === 0 || payload.byteLength > frameLimit) {
    throw protocol(`MessagePack payload exceeds ${frameLimit} bytes`);
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength).copy(
    frame,
    4,
  );
  return frame;
}

export function decodeNativeTuiFrame(
  frame: Uint8Array,
  maxFrameBytes = NATIVE_TUI_MAX_FRAME_BYTES,
): NativeTuiWireMessage {
  const frameLimit = boundedFrameLimit(maxFrameBytes);
  if (frame.byteLength < 4) {
    throw protocol("Frame is shorter than its four-byte header");
  }
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const payloadBytes = bytes.readUInt32BE(0);
  if (payloadBytes === 0) throw protocol("Zero-length frames are invalid");
  if (payloadBytes > frameLimit) {
    throw protocol(
      `Frame declares ${payloadBytes} bytes; maximum is ${frameLimit}`,
    );
  }
  const expected = payloadBytes + 4;
  if (bytes.byteLength < expected) throw protocol("Frame payload is truncated");
  if (bytes.byteLength > expected) throw protocol("Frame contains trailing bytes");
  let value: unknown;
  try {
    value = decode(bytes.subarray(4), {
      maxStrLength: Math.min(frameLimit, NATIVE_TUI_MAX_CODE_BYTES * 4_096),
      maxBinLength: frameLimit,
      maxArrayLength: NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS,
      maxMapLength: 32,
      maxExtLength: 0,
    });
  } catch (error) {
    throw protocol(
      `Invalid MessagePack payload: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  return validateNativeTuiMessage(value);
}

export class NativeTuiFrameDecoder {
  private buffered = Buffer.alloc(0);
  private readonly frameLimit: number;

  constructor(maxFrameBytes = NATIVE_TUI_MAX_FRAME_BYTES) {
    this.frameLimit = boundedFrameLimit(maxFrameBytes);
  }

  push(chunk: Uint8Array): NativeTuiWireMessage[] {
    if (chunk.byteLength === 0) return [];
    const maxBufferedBytes = this.frameLimit + 4;
    if (
      this.buffered.byteLength > maxBufferedBytes ||
      chunk.byteLength > maxBufferedBytes - this.buffered.byteLength
    ) {
      throw protocol("Buffered frame exceeds the maximum size");
    }
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: NativeTuiWireMessage[] = [];
    while (this.buffered.byteLength >= 4) {
      const payloadBytes = this.buffered.readUInt32BE(0);
      if (payloadBytes === 0) throw protocol("Zero-length frames are invalid");
      if (payloadBytes > this.frameLimit) {
        throw protocol(
          `Frame declares ${payloadBytes} bytes; maximum is ${this.frameLimit}`,
        );
      }
      const frameBytes = payloadBytes + 4;
      if (this.buffered.byteLength < frameBytes) break;
      const frame = this.buffered.subarray(0, frameBytes);
      this.buffered = this.buffered.subarray(frameBytes);
      messages.push(decodeNativeTuiFrame(frame, this.frameLimit));
    }
    if (this.buffered.byteLength > this.frameLimit + 4) {
      throw protocol("Buffered frame exceeds the maximum size");
    }
    return messages;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}

export function validateNativeTuiMessage(
  value: unknown,
  context = "native TUI message",
): NativeTuiWireMessage {
  const object = exact(value, ["type"], context, true);
  const type = stringValue(object.type, `${context}.type`);
  switch (type) {
    case "handshake":
      return validateHandshake(value, context);
    case "capabilities":
      return validateCapabilitiesMessage(value, context);
    case "terminal_size":
      return validateTerminalSize(value, context);
    case "input_event":
      return validateInputEvent(value, context);
    case "render_snapshot":
      return validateRenderSnapshot(value, context);
    case "ack":
      return validateAck(value, context);
    case "error":
      return validateError(value, context);
    case "shutdown":
      return validateShutdown(value, context);
    default:
      throw protocol(`${context}.type is not supported`);
  }
}

export function validateNativeTuiClientMessage(
  value: unknown,
  context = "native TUI client message",
): NativeTuiClientMessage {
  const message = validateNativeTuiMessage(value, context);
  if (
    message.type !== "handshake" &&
    message.type !== "capabilities" &&
    message.type !== "terminal_size" &&
    message.type !== "input_event" &&
    message.type !== "shutdown"
  ) {
    throw protocol(`${context}.type is not valid from the client`);
  }
  return message;
}

export function validateNativeTuiServerMessage(
  value: unknown,
  context = "native TUI server message",
): NativeTuiServerMessage {
  const message = validateNativeTuiMessage(value, context);
  if (
    message.type !== "capabilities" &&
    message.type !== "render_snapshot" &&
    message.type !== "ack" &&
    message.type !== "error" &&
    message.type !== "shutdown"
  ) {
    throw protocol(`${context}.type is not valid from the server`);
  }
  return message;
}

export const encodeFrame = encodeNativeTuiFrame;
export const decodeFrame = decodeNativeTuiFrame;
export const FrameDecoder = NativeTuiFrameDecoder;
export const encodeUiFrame = encodeNativeTuiFrame;
export const decodeUiFrame = decodeNativeTuiFrame;
export const UiFrameDecoder = NativeTuiFrameDecoder;
export const validateUiMessage = validateNativeTuiMessage;
export const MAX_FRAME_BYTES = NATIVE_TUI_MAX_FRAME_BYTES;
export const UI_PROTOCOL_VERSION = NATIVE_TUI_PROTOCOL_VERSION;

function validateHandshake(value: unknown, context: string): NativeTuiHandshake {
  const object = exact(
    value,
    ["type", "version", "id", "client", "capabilities"],
    context,
  );
  return {
    type: "handshake",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    client: boundedText(
      required(object, "client", context),
      `${context}.client`,
      NATIVE_TUI_MAX_CLIENT_BYTES,
      false,
    ),
    capabilities: capabilitiesValue(
      required(object, "capabilities", context),
      `${context}.capabilities`,
    ),
  };
}

function validateCapabilitiesMessage(
  value: unknown,
  context: string,
): NativeTuiCapabilities {
  const object = exact(
    value,
    ["type", "version", "id", "capabilities"],
    context,
  );
  return {
    type: "capabilities",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    capabilities: capabilitiesValue(
      required(object, "capabilities", context),
      `${context}.capabilities`,
    ),
  };
}

function validateTerminalSize(
  value: unknown,
  context: string,
): NativeTuiTerminalSize {
  const object = exact(
    value,
    ["type", "version", "id", "columns", "rows"],
    context,
  );
  const columns = boundedInteger(
    required(object, "columns", context),
    `${context}.columns`,
    1,
    65_535,
  );
  const rows = boundedInteger(
    required(object, "rows", context),
    `${context}.rows`,
    1,
    65_535,
  );
  return {
    type: "terminal_size",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    columns,
    rows,
  };
}

function validateInputEvent(value: unknown, context: string): NativeTuiInputEvent {
  const object = exact(
    value,
    ["type", "version", "id", "sequence", "event"],
    context,
  );
  return {
    type: "input_event",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    sequence: nonNegativeInteger(
      required(object, "sequence", context),
      `${context}.sequence`,
    ),
    event: validateInputEventKind(
      required(object, "event", context),
      `${context}.event`,
    ),
  };
}

function validateInputEventKind(
  value: unknown,
  context: string,
): NativeTuiInputEventKind {
  const object = record(value, context);
  const type = stringValue(object.type, `${context}.type`);
  switch (type) {
    case "key": {
      const exactObject = exact(object, ["type", "key", "modifiers"], context);
      return {
        type: "key",
        key: boundedText(
          required(exactObject, "key", context),
          `${context}.key`,
          NATIVE_TUI_MAX_INPUT_BYTES,
          false,
        ),
        modifiers: modifiersValue(
          required(exactObject, "modifiers", context),
          `${context}.modifiers`,
        ),
      };
    }
    case "text":
    case "paste": {
      const exactObject = exact(object, ["type", "text"], context);
      return {
        type,
        text: boundedText(
          required(exactObject, "text", context),
          `${context}.text`,
          NATIVE_TUI_MAX_INPUT_BYTES,
          true,
        ),
      };
    }
    case "mouse": {
      const exactObject = exact(
        object,
        ["type", "x", "y", "button", "kind", "modifiers"],
        context,
      );
      return {
        type: "mouse",
        x: boundedInteger(required(exactObject, "x", context), `${context}.x`, 0, 65_535),
        y: boundedInteger(required(exactObject, "y", context), `${context}.y`, 0, 65_535),
        button: enumValue(
          required(exactObject, "button", context),
          ["none", "left", "middle", "right", "other"],
          `${context}.button`,
        ) as NativeTuiMouseButton,
        kind: enumValue(
          required(exactObject, "kind", context),
          ["move", "down", "up", "drag", "scroll_up", "scroll_down"],
          `${context}.kind`,
        ) as NativeTuiMouseEventKind,
        modifiers: modifiersValue(
          required(exactObject, "modifiers", context),
          `${context}.modifiers`,
        ),
      };
    }
    case "action": {
      const exactObject = exact(
        object,
        ["type", "action", "target", "value"],
        context,
      );
      const result: NativeTuiActionInput = {
        type: "action",
        action: boundedText(
          required(exactObject, "action", context),
          `${context}.action`,
          NATIVE_TUI_MAX_ACTION_BYTES,
          false,
        ),
      };
      if (has(exactObject, "target") && exactObject.target !== null) {
        result.target = boundedText(
          exactObject.target,
          `${context}.target`,
          NATIVE_TUI_MAX_ACTION_BYTES,
          true,
        );
      }
      if (has(exactObject, "value") && exactObject.value !== null) {
        result.value = boundedText(
          exactObject.value,
          `${context}.value`,
          NATIVE_TUI_MAX_ACTION_VALUE_BYTES,
          true,
        );
      }
      return result;
    }
    case "submit":
    case "cancel":
    case "interrupt":
      exact(object, ["type"], context);
      return { type };
    default:
      throw protocol(`${context}.type is not supported`);
  }
}

function validateAck(value: unknown, context: string): NativeTuiAck {
  const object = exact(
    value,
    ["type", "version", "id", "sequence"],
    context,
  );
  return {
    type: "ack",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    sequence: nonNegativeInteger(
      required(object, "sequence", context),
      `${context}.sequence`,
    ),
  };
}

function validateError(value: unknown, context: string): NativeTuiError {
  const object = exact(
    value,
    ["type", "version", "id", "code", "message", "details"],
    context,
  );
  const result: NativeTuiError = {
    type: "error",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    code: boundedText(
      required(object, "code", context),
      `${context}.code`,
      NATIVE_TUI_MAX_CODE_BYTES,
      false,
    ),
    message: boundedText(
      required(object, "message", context),
      `${context}.message`,
      NATIVE_TUI_MAX_MESSAGE_BYTES,
      true,
    ),
  };
  if (has(object, "details") && object.details !== null) {
    result.details = boundedText(
      object.details,
      `${context}.details`,
      NATIVE_TUI_MAX_MESSAGE_BYTES,
      true,
    );
  }
  return result;
}

function validateShutdown(value: unknown, context: string): NativeTuiShutdown {
  const object = exact(
    value,
    ["type", "version", "id", "reason"],
    context,
  );
  const result: NativeTuiShutdown = {
    type: "shutdown",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
  };
  if (has(object, "reason") && object.reason !== null) {
    result.reason = boundedText(
      object.reason,
      `${context}.reason`,
      NATIVE_TUI_MAX_REASON_BYTES,
      true,
    );
  }
  return result;
}

function validateRenderSnapshot(
  value: unknown,
  context: string,
): NativeTuiRenderSnapshot {
  const object = exact(
    value,
    [
      "type",
      "version",
      "id",
      "sequence",
      "sessions",
      "workspaces",
      "active_session_id",
      "status",
      "telemetry",
      "tasks",
      "agents",
      "transcript",
      "transcript_window",
      "changes",
      "activity",
      "permissions",
      "writer",
    ],
    context,
  );
  const result: NativeTuiRenderSnapshot = {
    type: "render_snapshot",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    sequence: nonNegativeInteger(
      required(object, "sequence", context),
      `${context}.sequence`,
    ),
    sessions: sessionsValue(required(object, "sessions", context), `${context}.sessions`),
    workspaces: workspacesValue(
      required(object, "workspaces", context),
      `${context}.workspaces`,
    ),
    status: validateStatus(required(object, "status", context), `${context}.status`),
    telemetry: validateTelemetry(
      required(object, "telemetry", context),
      `${context}.telemetry`,
    ),
    tasks: tasksValue(required(object, "tasks", context), `${context}.tasks`),
    agents: agentsValue(required(object, "agents", context), `${context}.agents`),
    transcript: transcriptValue(
      required(object, "transcript", context),
      `${context}.transcript`,
    ),
    changes: changesValue(required(object, "changes", context), `${context}.changes`),
    activity: activityValue(required(object, "activity", context), `${context}.activity`),
    permissions: permissionsValue(
      required(object, "permissions", context),
      `${context}.permissions`,
    ),
    writer: validateWriter(
      required(object, "writer", context),
      `${context}.writer`,
    ),
  };
  if (has(object, "active_session_id") && object.active_session_id !== null) {
    result.active_session_id = boundedText(
      object.active_session_id,
      `${context}.active_session_id`,
      NATIVE_TUI_MAX_ID_BYTES,
      false,
    );
  }
  if (has(object, "transcript_window") && object.transcript_window !== null) {
    result.transcript_window = validateTranscriptWindow(
      object.transcript_window,
      `${context}.transcript_window`,
    );
  }
  if (snapshotByteLength(result) > NATIVE_TUI_MAX_SNAPSHOT_BYTES) {
    throw protocol(
      `snapshot aggregate exceeds ${NATIVE_TUI_MAX_SNAPSHOT_BYTES} bytes`,
    );
  }
  return result;
}

function validateStatus(value: unknown, context: string): NativeTuiStatusSnapshot {
  const object = exact(value, ["state", "message", "detail"], context);
  const result: NativeTuiStatusSnapshot = {
    state: boundedText(required(object, "state", context), `${context}.state`, NATIVE_TUI_MAX_STATUS_BYTES, false),
  };
  for (const field of ["message", "detail"] as const) {
    if (has(object, field) && object[field] !== null) {
      result[field] = boundedText(object[field], `${context}.${field}`, NATIVE_TUI_MAX_STATUS_BYTES, true);
    }
  }
  return result;
}

function validateTelemetry(value: unknown, context: string): NativeTuiTelemetrySnapshot {
  const object = exact(
    value,
    [
      "connection",
      "model",
      "effort",
      "context_used_tokens",
      "context_limit_tokens",
      "input_tokens",
      "output_tokens",
      "cached_tokens",
      "reasoning_tokens",
      "credits",
      "active_agents",
      "queued_tasks",
      "api_requests",
      "latency_ms",
    ],
    context,
  );
  const connectionObject = exact(
    requiredRecord(object, "connection", context),
    ["state", "reconnect_attempts", "last_error"],
    `${context}.connection`,
  );
  const result: NativeTuiTelemetrySnapshot = {
    connection: {
      state: boundedText(required(connectionObject, "state", context), `${context}.connection.state`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
      reconnect_attempts: nonNegativeInteger(required(connectionObject, "reconnect_attempts", context), `${context}.connection.reconnect_attempts`),
    },
    model: boundedText(required(object, "model", context), `${context}.model`, NATIVE_TUI_MAX_MODEL_BYTES, false),
    effort: boundedText(required(object, "effort", context), `${context}.effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
    context_used_tokens: nonNegativeInteger(required(object, "context_used_tokens", context), `${context}.context_used_tokens`),
    context_limit_tokens: positiveInteger(required(object, "context_limit_tokens", context), `${context}.context_limit_tokens`),
    input_tokens: nonNegativeInteger(required(object, "input_tokens", context), `${context}.input_tokens`),
    output_tokens: nonNegativeInteger(required(object, "output_tokens", context), `${context}.output_tokens`),
    cached_tokens: nonNegativeInteger(required(object, "cached_tokens", context), `${context}.cached_tokens`),
    reasoning_tokens: nonNegativeInteger(required(object, "reasoning_tokens", context), `${context}.reasoning_tokens`),
    credits: boundedNumber(required(object, "credits", context), `${context}.credits`, 0),
    active_agents: boundedInteger(required(object, "active_agents", context), `${context}.active_agents`, 0, 65_535),
    queued_tasks: boundedInteger(required(object, "queued_tasks", context), `${context}.queued_tasks`, 0, 65_535),
    api_requests: nonNegativeInteger(required(object, "api_requests", context), `${context}.api_requests`),
    latency_ms: nonNegativeInteger(required(object, "latency_ms", context), `${context}.latency_ms`),
  };
  if (result.context_used_tokens > result.context_limit_tokens) {
    throw protocol(`${context} context usage exceeds context limit`);
  }
  if (has(connectionObject, "last_error") && connectionObject.last_error !== null) {
    result.connection.last_error = boundedText(connectionObject.last_error, `${context}.connection.last_error`, NATIVE_TUI_MAX_MESSAGE_BYTES, true);
  }
  return result;
}

function validateWorkspace(value: unknown, context: string): NativeTuiWorkspaceSnapshot {
  const object = exact(value, ["id", "name", "path", "active"], context);
  return {
    id: idValue(required(object, "id", context), `${context}.id`),
    name: boundedText(required(object, "name", context), `${context}.name`, NATIVE_TUI_MAX_SESSION_NAME_BYTES, false),
    path: boundedText(required(object, "path", context), `${context}.path`, NATIVE_TUI_MAX_WORKSPACE_BYTES, false),
    active: booleanValue(required(object, "active", context), `${context}.active`),
  };
}

function validateSession(value: unknown, context: string): NativeTuiSessionSnapshot {
  const object = exact(value, ["id", "name", "workspace", "status", "model", "effort", "active", "pinned", "unread", "created_at_ms", "updated_at_ms"], context);
  return {
    id: idValue(required(object, "id", context), `${context}.id`),
    name: boundedText(required(object, "name", context), `${context}.name`, NATIVE_TUI_MAX_SESSION_NAME_BYTES, false),
    workspace: boundedText(required(object, "workspace", context), `${context}.workspace`, NATIVE_TUI_MAX_WORKSPACE_BYTES, false),
    status: boundedText(required(object, "status", context), `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
    model: boundedText(required(object, "model", context), `${context}.model`, NATIVE_TUI_MAX_MODEL_BYTES, false),
    effort: boundedText(required(object, "effort", context), `${context}.effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
    active: booleanValue(required(object, "active", context), `${context}.active`),
    pinned: booleanValue(required(object, "pinned", context), `${context}.pinned`),
    unread: boundedInteger(required(object, "unread", context), `${context}.unread`, 0, 0xffff_ffff),
    created_at_ms: nonNegativeInteger(required(object, "created_at_ms", context), `${context}.created_at_ms`),
    updated_at_ms: nonNegativeInteger(required(object, "updated_at_ms", context), `${context}.updated_at_ms`),
  };
}

function validateTask(value: unknown, context: string): NativeTuiTaskSnapshot {
  const object = exact(value, ["id", "title", "status", "detail", "progress", "metadata"], context);
  const result: NativeTuiTaskSnapshot = {
    id: boundedText(required(object, "id", context), `${context}.id`, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
    title: boundedText(required(object, "title", context), `${context}.title`, NATIVE_TUI_MAX_TASK_TITLE_BYTES, true),
    status: boundedText(required(object, "status", context), `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
    metadata: validateTaskMetadata(requiredRecord(object, "metadata", context), `${context}.metadata`),
  };
  if (has(object, "detail") && object.detail !== null) result.detail = boundedText(object.detail, `${context}.detail`, NATIVE_TUI_MAX_STATUS_BYTES, true);
  if (has(object, "progress") && object.progress !== null) result.progress = boundedInteger(object.progress, `${context}.progress`, 0, 100);
  return result;
}

function validateTaskMetadata(value: Record<string, unknown>, context: string): NativeTuiTaskMetadata {
  const object = exact(value, ["parent_id", "owner", "agent_id", "model", "effort", "dependencies", "blocked_by", "files_touched", "isolation"], context);
  const result: NativeTuiTaskMetadata = {
    dependencies: has(object, "dependencies") ? boundedStringArray(object.dependencies, `${context}.dependencies`, NATIVE_TUI_MAX_DEPENDENCIES, NATIVE_TUI_MAX_TASK_ID_BYTES, false) : [],
    blocked_by: has(object, "blocked_by") ? boundedStringArray(object.blocked_by, `${context}.blocked_by`, NATIVE_TUI_MAX_DEPENDENCIES, NATIVE_TUI_MAX_TASK_ID_BYTES, false) : [],
    files_touched: has(object, "files_touched") ? boundedStringArray(object.files_touched, `${context}.files_touched`, NATIVE_TUI_MAX_FILES, NATIVE_TUI_MAX_FILE_PATH_BYTES, false) : [],
  };
  for (const field of ["parent_id", "owner", "agent_id", "model", "effort", "isolation"] as const) {
    if (has(object, field) && object[field] !== null) {
      result[field] = boundedText(object[field], `${context}.${field}`, field === "agent_id" ? NATIVE_TUI_MAX_AGENT_ID_BYTES : field === "model" ? NATIVE_TUI_MAX_MODEL_BYTES : field === "effort" ? NATIVE_TUI_MAX_EFFORT_BYTES : field === "isolation" ? NATIVE_TUI_MAX_CONNECTION_BYTES : field === "owner" ? NATIVE_TUI_MAX_AGENT_NAME_BYTES : NATIVE_TUI_MAX_TASK_ID_BYTES, false);
    }
  }
  return result;
}

function validateAgent(value: unknown, context: string): NativeTuiAgentSnapshot {
  const object = exact(value, ["id", "name", "role", "status", "parent_id", "task_id", "model", "effort", "progress"], context);
  const result: NativeTuiAgentSnapshot = {
    id: boundedText(required(object, "id", context), `${context}.id`, NATIVE_TUI_MAX_AGENT_ID_BYTES, false),
    name: boundedText(required(object, "name", context), `${context}.name`, NATIVE_TUI_MAX_AGENT_NAME_BYTES, false),
    role: boundedText(required(object, "role", context), `${context}.role`, NATIVE_TUI_MAX_AGENT_NAME_BYTES, false),
    status: boundedText(required(object, "status", context), `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
    model: boundedText(required(object, "model", context), `${context}.model`, NATIVE_TUI_MAX_MODEL_BYTES, false),
    effort: boundedText(required(object, "effort", context), `${context}.effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
  };
  for (const field of ["parent_id", "task_id"] as const) {
    if (has(object, field) && object[field] !== null) result[field] = boundedText(object[field], `${context}.${field}`, field === "parent_id" ? NATIVE_TUI_MAX_AGENT_ID_BYTES : NATIVE_TUI_MAX_TASK_ID_BYTES, false);
  }
  if (has(object, "progress") && object.progress !== null) result.progress = boundedInteger(object.progress, `${context}.progress`, 0, 100);
  return result;
}

function validateTranscriptBlock(value: unknown, context: string): NativeTuiTranscriptBlock {
  const object = record(value, context);
  const type = stringValue(object.type, `${context}.type`);
  switch (type) {
    case "markdown": {
      const item = exact(object, ["type", "id", "sequence", "role", "text", "created_at_ms"], context);
      const result: NativeTuiMarkdownBlock = {
        type: "markdown",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        role: boundedText(required(item, "role", context), `${context}.role`, NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES, false),
        text: boundedText(required(item, "text", context), `${context}.text`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
      };
      if (has(item, "created_at_ms") && item.created_at_ms !== null) result.created_at_ms = nonNegativeInteger(item.created_at_ms, `${context}.created_at_ms`);
      return result;
    }
    case "code": {
      const item = exact(object, ["type", "id", "sequence", "role", "language", "code", "file_path", "start_line", "end_line"], context);
      const result: NativeTuiCodeBlock = {
        type: "code",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        role: boundedText(required(item, "role", context), `${context}.role`, NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES, false),
        language: boundedText(required(item, "language", context), `${context}.language`, NATIVE_TUI_MAX_LANGUAGE_BYTES, false),
        code: boundedText(required(item, "code", context), `${context}.code`, NATIVE_TUI_MAX_CODE_BYTES * 4_096, true),
      };
      if (has(item, "file_path") && item.file_path !== null) result.file_path = boundedText(item.file_path, `${context}.file_path`, NATIVE_TUI_MAX_FILE_PATH_BYTES, true);
      for (const field of ["start_line", "end_line"] as const) if (has(item, field) && item[field] !== null) result[field] = boundedInteger(item[field], `${context}.${field}`, 0, 0xffff_ffff);
      if (result.start_line !== undefined && result.end_line !== undefined && result.start_line > result.end_line) throw protocol(`${context} start line must not exceed end line`);
      return result;
    }
    case "tool": {
      const item = exact(object, ["type", "id", "sequence", "name", "status", "input", "output", "duration_ms"], context);
      const result: NativeTuiToolBlock = {
        type: "tool",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        name: boundedText(required(item, "name", context), `${context}.name`, NATIVE_TUI_MAX_TOOL_NAME_BYTES, false),
        status: boundedText(required(item, "status", context), `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
      };
      for (const field of ["input", "output"] as const) if (has(item, field) && item[field] !== null) result[field] = boundedText(item[field], `${context}.${field}`, field === "input" ? NATIVE_TUI_MAX_TOOL_ARGUMENTS_BYTES : NATIVE_TUI_MAX_TOOL_OUTPUT_BYTES, true);
      if (has(item, "duration_ms") && item.duration_ms !== null) result.duration_ms = nonNegativeInteger(item.duration_ms, `${context}.duration_ms`);
      return result;
    }
    case "thinking": {
      const item = exact(object, ["type", "id", "sequence", "summary", "effort", "elapsed_ms", "tokens_used"], context);
      return {
        type: "thinking",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        summary: boundedText(required(item, "summary", context), `${context}.summary`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
        effort: boundedText(required(item, "effort", context), `${context}.effort`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
        elapsed_ms: nonNegativeInteger(required(item, "elapsed_ms", context), `${context}.elapsed_ms`),
        tokens_used: nonNegativeInteger(required(item, "tokens_used", context), `${context}.tokens_used`),
      };
    }
    case "report": {
      const item = exact(object, ["type", "id", "sequence", "task_id", "status", "summary", "changed_files", "evidence", "tokens_used", "effort_used"], context);
      return {
        type: "report",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        task_id: boundedText(required(item, "task_id", context), `${context}.task_id`, NATIVE_TUI_MAX_TASK_ID_BYTES, false),
        status: boundedText(required(item, "status", context), `${context}.status`, NATIVE_TUI_MAX_STATUS_BYTES, false),
        summary: boundedText(required(item, "summary", context), `${context}.summary`, NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES, true),
        changed_files: boundedStringArray(required(item, "changed_files", context), `${context}.changed_files`, NATIVE_TUI_MAX_FILES, NATIVE_TUI_MAX_FILE_PATH_BYTES, false),
        evidence: boundedStringArray(required(item, "evidence", context), `${context}.evidence`, NATIVE_TUI_MAX_REPORT_EVIDENCE, NATIVE_TUI_MAX_REPORT_EVIDENCE_BYTES, true),
        tokens_used: nonNegativeInteger(required(item, "tokens_used", context), `${context}.tokens_used`),
        effort_used: boundedText(required(item, "effort_used", context), `${context}.effort_used`, NATIVE_TUI_MAX_EFFORT_BYTES, false),
      };
    }
    case "error": {
      const item = exact(object, ["type", "id", "sequence", "code", "message", "detail", "recoverable"], context);
      const result: NativeTuiErrorBlock = {
        type: "error",
        id: boundedText(required(item, "id", context), `${context}.id`, NATIVE_TUI_MAX_TRANSCRIPT_ID_BYTES, false),
        sequence: nonNegativeInteger(required(item, "sequence", context), `${context}.sequence`),
        code: boundedText(required(item, "code", context), `${context}.code`, NATIVE_TUI_MAX_CODE_BYTES, false),
        message: boundedText(required(item, "message", context), `${context}.message`, NATIVE_TUI_MAX_MESSAGE_BYTES, true),
        recoverable: booleanValue(required(item, "recoverable", context), `${context}.recoverable`),
      };
      if (has(item, "detail") && item.detail !== null) result.detail = boundedText(item.detail, `${context}.detail`, NATIVE_TUI_MAX_MESSAGE_BYTES, true);
      return result;
    }
    default:
      throw protocol(`${context}.type is not supported`);
  }
}

function validateTranscriptWindow(value: unknown, context: string): NativeTuiTranscriptWindow {
  const object = exact(value, ["start_sequence", "end_sequence", "has_older", "has_newer", "blocks"], context);
  const start = nonNegativeInteger(required(object, "start_sequence", context), `${context}.start_sequence`);
  const end = nonNegativeInteger(required(object, "end_sequence", context), `${context}.end_sequence`);
  if (start > end) throw protocol(`${context} start sequence must not exceed end sequence`);
  return {
    start_sequence: start,
    end_sequence: end,
    has_older: booleanValue(required(object, "has_older", context), `${context}.has_older`),
    has_newer: booleanValue(required(object, "has_newer", context), `${context}.has_newer`),
    blocks: transcriptValue(required(object, "blocks", context), `${context}.blocks`),
  };
}

function validateChange(value: unknown, context: string): NativeTuiChangeSnapshot {
  const object = exact(value, ["path", "kind", "additions", "deletions", "staged", "language", "diff"], context);
  const result: NativeTuiChangeSnapshot = {
    path: boundedText(required(object, "path", context), `${context}.path`, NATIVE_TUI_MAX_FILE_PATH_BYTES, false),
    kind: boundedText(required(object, "kind", context), `${context}.kind`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    additions: nonNegativeInteger(required(object, "additions", context), `${context}.additions`),
    deletions: nonNegativeInteger(required(object, "deletions", context), `${context}.deletions`),
    staged: booleanValue(required(object, "staged", context), `${context}.staged`),
  };
  if (has(object, "language") && object.language !== null) result.language = boundedText(object.language, `${context}.language`, NATIVE_TUI_MAX_LANGUAGE_BYTES, true);
  if (has(object, "diff") && object.diff !== null) result.diff = boundedText(object.diff, `${context}.diff`, NATIVE_TUI_MAX_DIFF_BYTES, true);
  return result;
}

function validateActivity(value: unknown, context: string): NativeTuiActivitySnapshot {
  const object = exact(value, ["id", "timestamp_ms", "kind", "message", "task_id", "agent_id", "severity"], context);
  const result: NativeTuiActivitySnapshot = {
    id: boundedText(required(object, "id", context), `${context}.id`, NATIVE_TUI_MAX_ACTIVITY_ID_BYTES, false),
    timestamp_ms: nonNegativeInteger(required(object, "timestamp_ms", context), `${context}.timestamp_ms`),
    kind: boundedText(required(object, "kind", context), `${context}.kind`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    message: boundedText(required(object, "message", context), `${context}.message`, NATIVE_TUI_MAX_ACTIVITY_MESSAGE_BYTES, true),
    severity: boundedText(required(object, "severity", context), `${context}.severity`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
  };
  for (const field of ["task_id", "agent_id"] as const) if (has(object, field) && object[field] !== null) result[field] = boundedText(object[field], `${context}.${field}`, field === "task_id" ? NATIVE_TUI_MAX_TASK_ID_BYTES : NATIVE_TUI_MAX_AGENT_ID_BYTES, false);
  return result;
}

function validatePermission(value: unknown, context: string): NativeTuiPermissionRequest {
  const object = exact(value, ["id", "tool", "action", "resource", "reason", "status", "requested_at_ms", "expires_at_ms", "task_id", "agent_id"], context);
  const result: NativeTuiPermissionRequest = {
    id: boundedText(required(object, "id", context), `${context}.id`, NATIVE_TUI_MAX_PERMISSION_ID_BYTES, false),
    tool: boundedText(required(object, "tool", context), `${context}.tool`, NATIVE_TUI_MAX_TOOL_NAME_BYTES, false),
    action: boundedText(required(object, "action", context), `${context}.action`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, false),
    resource: boundedText(required(object, "resource", context), `${context}.resource`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, true),
    reason: boundedText(required(object, "reason", context), `${context}.reason`, NATIVE_TUI_MAX_PERMISSION_TEXT_BYTES, true),
    status: boundedText(required(object, "status", context), `${context}.status`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    requested_at_ms: nonNegativeInteger(required(object, "requested_at_ms", context), `${context}.requested_at_ms`),
  };
  for (const field of ["expires_at_ms"] as const) if (has(object, field) && object[field] !== null) result[field] = nonNegativeInteger(object[field], `${context}.${field}`);
  for (const field of ["task_id", "agent_id"] as const) if (has(object, field) && object[field] !== null) result[field] = boundedText(object[field], `${context}.${field}`, field === "task_id" ? NATIVE_TUI_MAX_TASK_ID_BYTES : NATIVE_TUI_MAX_AGENT_ID_BYTES, false);
  return result;
}

function validateWriter(value: unknown, context: string): NativeTuiWriterState {
  const object = exact(value, ["mode", "writer_id", "lease_expires_at_ms", "observers"], context);
  const result: NativeTuiWriterState = {
    mode: boundedText(required(object, "mode", context), `${context}.mode`, NATIVE_TUI_MAX_CONNECTION_BYTES, false),
    observers: has(object, "observers") ? boundedStringArray(object.observers, `${context}.observers`, NATIVE_TUI_MAX_WRITERS, NATIVE_TUI_MAX_ID_BYTES, false) : [],
  };
  if (has(object, "writer_id") && object.writer_id !== null) result.writer_id = boundedText(object.writer_id, `${context}.writer_id`, NATIVE_TUI_MAX_ID_BYTES, false);
  if (has(object, "lease_expires_at_ms") && object.lease_expires_at_ms !== null) result.lease_expires_at_ms = nonNegativeInteger(object.lease_expires_at_ms, `${context}.lease_expires_at_ms`);
  return result;
}

function sessionsValue(value: unknown, context: string): NativeTuiSessionSnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_SESSIONS, validateSession);
}

function workspacesValue(value: unknown, context: string): NativeTuiWorkspaceSnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_WORKSPACES, validateWorkspace);
}

function tasksValue(value: unknown, context: string): NativeTuiTaskSnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_TASKS, validateTask);
}

function agentsValue(value: unknown, context: string): NativeTuiAgentSnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_AGENTS, validateAgent);
}

function transcriptValue(value: unknown, context: string): NativeTuiTranscriptBlock[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS, validateTranscriptBlock);
}

function changesValue(value: unknown, context: string): NativeTuiChangeSnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_FILES, validateChange);
}

function activityValue(value: unknown, context: string): NativeTuiActivitySnapshot[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_ACTIVITY, validateActivity);
}

function permissionsValue(value: unknown, context: string): NativeTuiPermissionRequest[] {
  return boundedObjectArray(value, context, NATIVE_TUI_MAX_PERMISSIONS, validatePermission);
}

function boundedObjectArray<T>(
  value: unknown,
  context: string,
  max: number,
  validator: (value: unknown, context: string) => T,
): T[] {
  if (!Array.isArray(value) || value.length > max) throw protocol(`${context} exceeds its maximum size`);
  return value.map((item, index) => validator(item, `${context}[${index}]`));
}

function capabilitiesValue(value: unknown, context: string): string[] {
  return boundedStringArray(value, context, NATIVE_TUI_MAX_CAPABILITIES, NATIVE_TUI_MAX_CAPABILITY_BYTES, false);
}

function modifiersValue(value: unknown, context: string): string[] {
  return boundedStringArray(value, context, NATIVE_TUI_MAX_INPUT_MODIFIERS, NATIVE_TUI_MAX_INPUT_BYTES, false);
}

function boundedStringArray(value: unknown, context: string, max: number, maxBytes: number, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || value.length > max) throw protocol(`${context} exceeds its maximum size`);
  return value.map((item, index) => boundedText(item, `${context}[${index}]`, maxBytes, allowEmpty));
}

function versionValue(value: unknown, context: string): typeof NATIVE_TUI_PROTOCOL_VERSION {
  if (value !== NATIVE_TUI_PROTOCOL_VERSION) throw protocol(`${context}.version is unsupported`);
  return NATIVE_TUI_PROTOCOL_VERSION;
}

function idValue(value: unknown, context: string): string {
  return boundedText(value, context, NATIVE_TUI_MAX_ID_BYTES, false);
}

function boundedText(value: unknown, context: string, maxBytes: number, allowEmpty: boolean): string {
  if (typeof value !== "string") throw protocol(`${context} must be a string`);
  if (!allowEmpty && value.length === 0) throw protocol(`${context} must not be empty`);
  if (byteLength(value) > maxBytes) throw protocol(`${context} exceeds ${maxBytes} bytes`);
  return value;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw protocol(`${context} must be a string`);
  return value;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw protocol(`${context} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  return boundedInteger(value, context, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, context: string): number {
  return boundedInteger(value, context, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(value: unknown, context: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw protocol(`${context} must be a safe integer in range`);
  return value as number;
}

function boundedNumber(value: unknown, context: string, min: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) throw protocol(`${context} must be a finite non-negative number`);
  return value;
}

function enumValue(value: unknown, allowed: readonly string[], context: string): string {
  if (typeof value !== "string" || !allowed.includes(value)) throw protocol(`${context} has an unsupported value`);
  return value;
}

function required(object: Record<string, unknown>, key: string, context: string): unknown {
  if (!has(object, key)) throw protocol(`${context}.${key} is required`);
  return object[key];
}

function requiredRecord(object: Record<string, unknown>, key: string, context: string): Record<string, unknown> {
  return record(required(object, key, context), `${context}.${key}`);
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw protocol(`${context} must be an object`);
  return value as Record<string, unknown>;
}

function exact(value: unknown, keys: readonly string[], context: string, onlyType = false): Record<string, unknown> {
  const object = record(value, context);
  if (onlyType) return object;
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) if (!allowed.has(key)) throw protocol(`${context} contains an unknown field`);
  return object;
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function snapshotByteLength(snapshot: NativeTuiRenderSnapshot): number {
  let total = 0;
  const add = (value: string | undefined): void => {
    if (value !== undefined) total += byteLength(value);
  };
  add(snapshot.id);
  add(snapshot.active_session_id);
  add(snapshot.status.state);
  add(snapshot.status.message);
  add(snapshot.status.detail);
  add(snapshot.telemetry.connection.state);
  add(snapshot.telemetry.connection.last_error);
  add(snapshot.telemetry.model);
  add(snapshot.telemetry.effort);
  for (const item of snapshot.sessions) for (const value of [item.id, item.name, item.workspace, item.status, item.model, item.effort]) add(value);
  for (const item of snapshot.workspaces) for (const value of [item.id, item.name, item.path]) add(value);
  for (const item of snapshot.tasks) {
    add(item.id); add(item.title); add(item.status); add(item.detail);
    for (const value of [item.metadata.parent_id, item.metadata.owner, item.metadata.agent_id, item.metadata.model, item.metadata.effort, item.metadata.isolation]) add(value);
    for (const value of [...item.metadata.dependencies, ...item.metadata.blocked_by, ...item.metadata.files_touched]) add(value);
  }
  for (const item of snapshot.agents) for (const value of [item.id, item.name, item.role, item.status, item.parent_id, item.task_id, item.model, item.effort]) add(value);
  for (const block of snapshot.transcript) addBlockBytes(block, add);
  if (snapshot.transcript_window) for (const block of snapshot.transcript_window.blocks) addBlockBytes(block, add);
  for (const item of snapshot.changes) for (const value of [item.path, item.kind, item.language, item.diff]) add(value);
  for (const item of snapshot.activity) for (const value of [item.id, item.kind, item.message, item.task_id, item.agent_id, item.severity]) add(value);
  for (const item of snapshot.permissions) for (const value of [item.id, item.tool, item.action, item.resource, item.reason, item.status, item.task_id, item.agent_id]) add(value);
  add(snapshot.writer.mode); add(snapshot.writer.writer_id); for (const observer of snapshot.writer.observers) add(observer);
  return total;
}

function addBlockBytes(block: NativeTuiTranscriptBlock, add: (value: string | undefined) => void): void {
  add(block.id);
  switch (block.type) {
    case "markdown": add(block.role); add(block.text); break;
    case "code": add(block.role); add(block.language); add(block.code); add(block.file_path); break;
    case "tool": add(block.name); add(block.status); add(block.input); add(block.output); break;
    case "thinking": add(block.summary); add(block.effort); break;
    case "report": add(block.task_id); add(block.status); add(block.summary); add(block.effort_used); for (const value of [...block.changed_files, ...block.evidence]) add(value); break;
    case "error": add(block.code); add(block.message); add(block.detail); break;
  }
}

function boundedFrameLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new NativeTuiProtocolError("Frame maximum must be a positive safe integer");
  return Math.min(value, NATIVE_TUI_MAX_FRAME_BYTES);
}

function protocol(message: string): NativeTuiProtocolError {
  return new NativeTuiProtocolError(message);
}
