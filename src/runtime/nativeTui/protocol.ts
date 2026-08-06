import { decode, encode } from "@msgpack/msgpack";

export const NATIVE_TUI_PROTOCOL_VERSION = 1 as const;
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
export const UI_MAX_TRANSCRIPT_ROLE_BYTES =
  NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES;
export const UI_MAX_TRANSCRIPT_TEXT_BYTES =
  NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES;
export const UI_MAX_SNAPSHOT_BYTES = NATIVE_TUI_MAX_SNAPSHOT_BYTES;
export const UI_MAX_CODE_BYTES = NATIVE_TUI_MAX_CODE_BYTES;
export const UI_MAX_MESSAGE_BYTES = NATIVE_TUI_MAX_MESSAGE_BYTES;
export const UI_MAX_REASON_BYTES = NATIVE_TUI_MAX_REASON_BYTES;
export const UI_MAX_PENDING_INPUTS = NATIVE_TUI_MAX_PENDING_INPUTS;

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

export type NativeTuiKeyInput = {
  type: "key";
  key: string;
  modifiers: string[];
};

export type NativeTuiInputEventKind =
  | NativeTuiKeyInput
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

export type NativeTuiTaskSnapshot = {
  id: string;
  title: string;
  status: string;
  detail?: string;
  progress?: number;
};

export type NativeTuiTranscriptEntry = {
  sequence: number;
  role: string;
  text: string;
};

export type NativeTuiRenderSnapshot = {
  type: "render_snapshot";
  version: typeof NATIVE_TUI_PROTOCOL_VERSION;
  id: string;
  sequence: number;
  status: NativeTuiStatusSnapshot;
  tasks: NativeTuiTaskSnapshot[];
  transcript: NativeTuiTranscriptEntry[];
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
    throw new NativeTuiProtocolError(
      `MessagePack encoding failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (payload.byteLength === 0 || payload.byteLength > frameLimit) {
    throw new NativeTuiProtocolError(
      `MessagePack payload exceeds ${frameLimit} bytes`,
    );
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
    throw new NativeTuiProtocolError(
      "Frame is shorter than its four-byte header",
    );
  }
  const bytes = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const payloadBytes = bytes.readUInt32BE(0);
  if (payloadBytes === 0) {
    throw new NativeTuiProtocolError("Zero-length frames are invalid");
  }
  if (payloadBytes > frameLimit) {
    throw new NativeTuiProtocolError(
      `Frame declares ${payloadBytes} bytes; maximum is ${frameLimit}`,
    );
  }
  const expected = payloadBytes + 4;
  if (bytes.byteLength < expected) {
    throw new NativeTuiProtocolError("Frame payload is truncated");
  }
  if (bytes.byteLength > expected) {
    throw new NativeTuiProtocolError("Frame contains trailing bytes");
  }
  let value: unknown;
  try {
    value = decode(bytes.subarray(4), {
      maxStrLength: NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
      maxBinLength: frameLimit,
      maxArrayLength: NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES,
      maxMapLength: 16,
      maxExtLength: 0,
    });
  } catch (error) {
    throw new NativeTuiProtocolError(
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
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: NativeTuiWireMessage[] = [];
    while (this.buffered.byteLength >= 4) {
      const payloadBytes = this.buffered.readUInt32BE(0);
      if (payloadBytes === 0) {
        throw new NativeTuiProtocolError("Zero-length frames are invalid");
      }
      if (payloadBytes > this.frameLimit) {
        throw new NativeTuiProtocolError(
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
      throw new NativeTuiProtocolError(
        "Buffered frame exceeds the maximum size",
      );
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

function validateHandshake(
  value: unknown,
  context: string,
): NativeTuiHandshake {
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
  const columns = positiveInteger(
    required(object, "columns", context),
    `${context}.columns`,
  );
  const rows = positiveInteger(
    required(object, "rows", context),
    `${context}.rows`,
  );
  if (columns > 65_535 || rows > 65_535) {
    throw protocol(`${context} terminal dimensions exceed u16`);
  }
  return {
    type: "terminal_size",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    columns,
    rows,
  };
}

function validateInputEvent(
  value: unknown,
  context: string,
): NativeTuiInputEvent {
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
    case "submit":
    case "cancel":
    case "interrupt":
      exact(object, ["type"], context);
      return { type };
    default:
      throw protocol(`${context}.type is not supported`);
  }
}

function validateRenderSnapshot(
  value: unknown,
  context: string,
): NativeTuiRenderSnapshot {
  const object = exact(
    value,
    ["type", "version", "id", "sequence", "status", "tasks", "transcript"],
    context,
  );
  return {
    type: "render_snapshot",
    version: versionValue(required(object, "version", context), context),
    id: idValue(required(object, "id", context), `${context}.id`),
    sequence: nonNegativeInteger(
      required(object, "sequence", context),
      `${context}.sequence`,
    ),
    status: validateStatus(
      required(object, "status", context),
      `${context}.status`,
    ),
    tasks: tasksValue(required(object, "tasks", context), `${context}.tasks`),
    transcript: transcriptValue(
      required(object, "transcript", context),
      `${context}.transcript`,
    ),
  };
}

function validateStatus(
  value: unknown,
  context: string,
): NativeTuiStatusSnapshot {
  const object = exact(
    objectOrValue(value, context),
    ["state", "message", "detail"],
    context,
  );
  const status: NativeTuiStatusSnapshot = {
    state: boundedText(
      required(object, "state", context),
      `${context}.state`,
      NATIVE_TUI_MAX_STATUS_BYTES,
      false,
    ),
  };
  if (has(object, "message") && object.message !== null) {
    status.message = boundedText(
      object.message,
      `${context}.message`,
      NATIVE_TUI_MAX_STATUS_BYTES,
      true,
    );
  }
  if (has(object, "detail") && object.detail !== null) {
    status.detail = boundedText(
      object.detail,
      `${context}.detail`,
      NATIVE_TUI_MAX_STATUS_BYTES,
      true,
    );
  }
  return status;
}

function validateTask(value: unknown, context: string): NativeTuiTaskSnapshot {
  const object = exact(
    objectOrValue(value, context),
    ["id", "title", "status", "detail", "progress"],
    context,
  );
  const task: NativeTuiTaskSnapshot = {
    id: boundedText(
      required(object, "id", context),
      `${context}.id`,
      NATIVE_TUI_MAX_TASK_ID_BYTES,
      false,
    ),
    title: boundedText(
      required(object, "title", context),
      `${context}.title`,
      NATIVE_TUI_MAX_TASK_TITLE_BYTES,
      true,
    ),
    status: boundedText(
      required(object, "status", context),
      `${context}.status`,
      NATIVE_TUI_MAX_STATUS_BYTES,
      false,
    ),
  };
  if (has(object, "detail") && object.detail !== null) {
    task.detail = boundedText(
      object.detail,
      `${context}.detail`,
      NATIVE_TUI_MAX_STATUS_BYTES,
      true,
    );
  }
  if (has(object, "progress")) {
    const progress = boundedInteger(
      object.progress,
      `${context}.progress`,
      0,
      100,
    );
    task.progress = progress;
  }
  return task;
}

function validateTranscript(
  value: unknown,
  context: string,
): NativeTuiTranscriptEntry {
  const object = exact(
    objectOrValue(value, context),
    ["sequence", "role", "text"],
    context,
  );
  return {
    sequence: nonNegativeInteger(
      required(object, "sequence", context),
      `${context}.sequence`,
    ),
    role: boundedText(
      required(object, "role", context),
      `${context}.role`,
      NATIVE_TUI_MAX_TRANSCRIPT_ROLE_BYTES,
      false,
    ),
    text: boundedText(
      required(object, "text", context),
      `${context}.text`,
      NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
      true,
    ),
  };
}

function validateAck(value: unknown, context: string): NativeTuiAck {
  const object = exact(value, ["type", "version", "id", "sequence"], context);
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
  const object = exact(value, ["type", "version", "id", "reason"], context);
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

function tasksValue(value: unknown, context: string): NativeTuiTaskSnapshot[] {
  if (!Array.isArray(value) || value.length > NATIVE_TUI_MAX_TASKS) {
    throw protocol(`${context} exceeds its maximum size`);
  }
  return value.map((item, index) => validateTask(item, `${context}[${index}]`));
}

function transcriptValue(
  value: unknown,
  context: string,
): NativeTuiTranscriptEntry[] {
  if (
    !Array.isArray(value) ||
    value.length > NATIVE_TUI_MAX_TRANSCRIPT_ENTRIES
  ) {
    throw protocol(`${context} exceeds its maximum size`);
  }
  const entries = value.map((item, index) =>
    validateTranscript(item, `${context}[${index}]`),
  );
  let totalBytes = 0;
  for (const entry of entries) {
    totalBytes += byteLength(entry.text);
    if (totalBytes > NATIVE_TUI_MAX_SNAPSHOT_BYTES) {
      throw protocol(
        `${context} exceeds ${NATIVE_TUI_MAX_SNAPSHOT_BYTES} bytes`,
      );
    }
  }
  return entries;
}

function capabilitiesValue(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > NATIVE_TUI_MAX_CAPABILITIES) {
    throw protocol(`${context} exceeds its maximum size`);
  }
  return value.map((item, index) =>
    boundedText(
      item,
      `${context}[${index}]`,
      NATIVE_TUI_MAX_CAPABILITY_BYTES,
      false,
    ),
  );
}

function modifiersValue(value: unknown, context: string): string[] {
  if (!Array.isArray(value) || value.length > NATIVE_TUI_MAX_INPUT_MODIFIERS) {
    throw protocol(`${context} exceeds its maximum size`);
  }
  return value.map((item, index) =>
    boundedText(
      item,
      `${context}[${index}]`,
      NATIVE_TUI_MAX_INPUT_BYTES,
      false,
    ),
  );
}

function versionValue(
  value: unknown,
  context: string,
): typeof NATIVE_TUI_PROTOCOL_VERSION {
  if (value !== NATIVE_TUI_PROTOCOL_VERSION) {
    throw protocol(`${context}.version is unsupported`);
  }
  return NATIVE_TUI_PROTOCOL_VERSION;
}

function idValue(value: unknown, context: string): string {
  return boundedText(value, context, NATIVE_TUI_MAX_ID_BYTES, false);
}

function boundedText(
  value: unknown,
  context: string,
  maxBytes: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string") throw protocol(`${context} must be a string`);
  if (!allowEmpty && value.length === 0)
    throw protocol(`${context} must not be empty`);
  if (byteLength(value) > maxBytes)
    throw protocol(`${context} exceeds ${maxBytes} bytes`);
  return value;
}

function stringValue(value: unknown, context: string): string {
  if (typeof value !== "string") throw protocol(`${context} must be a string`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  return boundedInteger(value, context, 1, Number.MAX_SAFE_INTEGER);
}

function nonNegativeInteger(value: unknown, context: string): number {
  return boundedInteger(value, context, 0, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: unknown,
  context: string,
  min: number,
  max: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < min ||
    (value as number) > max
  ) {
    throw protocol(`${context} must be a safe integer in range`);
  }
  return value as number;
}

function objectOrValue(
  value: unknown,
  context: string,
): Record<string, unknown> {
  return record(value, context);
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocol(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  context: string,
  onlyType = false,
): Record<string, unknown> {
  const object = record(value, context);
  if (onlyType) return object;
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      throw protocol(`${context} contains an unknown field`);
  }
  return object;
}

function required(
  object: Record<string, unknown>,
  key: string,
  context: string,
): unknown {
  if (!has(object, key)) throw protocol(`${context}.${key} is required`);
  return object[key];
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function byteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function boundedFrameLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new NativeTuiProtocolError(
      "Frame maximum must be a positive safe integer",
    );
  }
  return Math.min(value, NATIVE_TUI_MAX_FRAME_BYTES);
}

function protocol(message: string): NativeTuiProtocolError {
  return new NativeTuiProtocolError(message);
}
