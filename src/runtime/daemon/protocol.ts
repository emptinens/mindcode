import { decode, encode } from "@msgpack/msgpack";

export const DAEMON_PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export type DaemonRequest = {
  type: "request";
  id: string;
  method: string;
  params?: unknown;
  stream?: boolean;
};

export type DaemonHandshake = {
  type: "handshake";
  id: string;
  version: typeof DAEMON_PROTOCOL_VERSION;
  client: string;
  capabilities: readonly string[];
};

export type DaemonHandshakeAck = {
  type: "handshake_ack";
  id: string;
  version: number;
  accepted: boolean;
  server?: string;
  capabilities?: readonly string[];
  error?: DaemonRemoteErrorPayload;
};

export type DaemonResponse = {
  type: "response";
  id: string;
  ok: boolean;
  result?: unknown;
  error?: DaemonRemoteErrorPayload;
};

export type DaemonStreamChunk = {
  type: "stream";
  id: string;
  seq: number;
  data: unknown;
};

export type DaemonCancel = {
  type: "cancel";
  id: string;
};

export type DaemonWireMessage =
  | DaemonRequest
  | DaemonHandshake
  | DaemonHandshakeAck
  | DaemonResponse
  | DaemonStreamChunk
  | DaemonCancel;

export type DaemonRemoteErrorPayload = {
  code?: string;
  message: string;
  details?: unknown;
};

export class DaemonProtocolError extends Error {
  readonly code = "DAEMON_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "DaemonProtocolError";
  }
}

export function encodeFrame(
  message: DaemonWireMessage,
  maxFrameBytes = MAX_FRAME_BYTES,
): Buffer {
  const payload = Buffer.from(encode(message));
  if (payload.byteLength > maxFrameBytes) {
    throw new DaemonProtocolError(
      `MessagePack payload exceeds ${maxFrameBytes} bytes`,
    );
  }

  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  private buffered = Buffer.alloc(0);

  constructor(private readonly maxFrameBytes = MAX_FRAME_BYTES) {}

  push(chunk: Uint8Array): DaemonWireMessage[] {
    if (chunk.byteLength === 0) return [];
    this.buffered = Buffer.concat([this.buffered, Buffer.from(chunk)]);
    const messages: DaemonWireMessage[] = [];

    while (this.buffered.byteLength >= 4) {
      const payloadBytes = this.buffered.readUInt32BE(0);
      if (payloadBytes > this.maxFrameBytes) {
        throw new DaemonProtocolError(
          `Frame declares ${payloadBytes} bytes; maximum is ${this.maxFrameBytes}`,
        );
      }
      const frameBytes = 4 + payloadBytes;
      if (this.buffered.byteLength < frameBytes) break;

      const payload = this.buffered.subarray(4, frameBytes);
      this.buffered = this.buffered.subarray(frameBytes);
      let decoded: unknown;
      try {
        decoded = decode(payload);
      } catch (error) {
        throw new DaemonProtocolError(
          `Invalid MessagePack payload: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isDaemonWireMessage(decoded)) {
        throw new DaemonProtocolError(
          "MessagePack value is not a daemon message",
        );
      }
      messages.push(decoded);
    }

    return messages;
  }

  reset(): void {
    this.buffered = Buffer.alloc(0);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasString(value: Record<string, unknown>, key: string): boolean {
  return typeof value[key] === "string" && value[key].length > 0;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isRemoteErrorPayload(
  value: unknown,
): value is DaemonRemoteErrorPayload {
  return (
    isRecord(value) && hasString(value, "code") && hasString(value, "message")
  );
}

function isDaemonWireMessage(value: unknown): value is DaemonWireMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;

  switch (value.type) {
    case "request":
      return hasString(value, "id") && hasString(value, "method");
    case "handshake":
      return (
        hasString(value, "id") &&
        value.version === DAEMON_PROTOCOL_VERSION &&
        hasString(value, "client") &&
        Array.isArray(value.capabilities)
      );
    case "handshake_ack":
      return (
        hasString(value, "id") &&
        value.version === DAEMON_PROTOCOL_VERSION &&
        typeof value.accepted === "boolean" &&
        (!hasOwn(value, "server") || typeof value.server === "string") &&
        (!hasOwn(value, "capabilities") || isStringArray(value.capabilities)) &&
        (!hasOwn(value, "error") || isRemoteErrorPayload(value.error)) &&
        (value.accepted ? !hasOwn(value, "error") : hasOwn(value, "error"))
      );
    case "response":
      return (
        hasString(value, "id") &&
        typeof value.ok === "boolean" &&
        (value.ok
          ? hasOwn(value, "result") && !hasOwn(value, "error")
          : hasOwn(value, "error") &&
            isRemoteErrorPayload(value.error) &&
            !hasOwn(value, "result"))
      );
    case "stream":
      return (
        hasString(value, "id") &&
        typeof value.seq === "number" &&
        Number.isSafeInteger(value.seq) &&
        value.seq >= 0 &&
        Object.prototype.hasOwnProperty.call(value, "data")
      );
    case "cancel":
      return hasString(value, "id");
    default:
      return false;
  }
}
