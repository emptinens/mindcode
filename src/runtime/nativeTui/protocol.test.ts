import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import {
  NATIVE_TUI_MAX_FRAME_BYTES,
  NATIVE_TUI_MAX_TASKS,
  NATIVE_TUI_PROTOCOL_VERSION,
  NativeTuiFrameDecoder,
  NativeTuiProtocolError,
  decodeNativeTuiFrame,
  encodeNativeTuiFrame,
  validateNativeTuiMessage,
} from "./protocol.js";

const handshake = {
  type: "handshake" as const,
  version: NATIVE_TUI_PROTOCOL_VERSION,
  id: "client-1",
  client: "ratatui",
  capabilities: ["input", "render_snapshot"],
};

const snapshot = {
  type: "render_snapshot" as const,
  version: NATIVE_TUI_PROTOCOL_VERSION,
  id: "session-1",
  sequence: 4,
  status: { state: "running", message: "working" },
  tasks: [{ id: "task-1", title: "Build", status: "running", progress: 50 }],
  transcript: [{ sequence: 3, role: "assistant", text: "done" }],
};

describe("native TUI protocol", () => {
  test("matches the Rust golden frames", () => {
    const goldenFrames = [
      "0000005d85a474797065a968616e647368616b65a776657273696f6e01a26964a8636c69656e742d31a6636c69656e74ac6d696e64636f64652d747569ac6361706162696c697469657392af72656e6465725f736e617073686f74a5696e707574",
      "0000005685a474797065ab696e7075745f6576656e74a776657273696f6e01a26964a7696e7075742d31a873657175656e636501a56576656e7483a474797065a36b6579a36b6579a163a96d6f6469666965727391a46374726c",
      "0000006887a474797065af72656e6465725f736e617073686f74a776657273696f6e01a26964a973657373696f6e2d31a873657175656e636501a673746174757382a57374617465a57265616479a76d657373616765a26f6ba57461736b7390aa7472616e73637269707490",
    ];
    for (const hex of goldenFrames) {
      const frame = Buffer.from(hex, "hex");
      const message = decodeNativeTuiFrame(frame);
      expect(encodeNativeTuiFrame(message).toString("hex")).toBe(hex);
    }
  });
  test("encodes four-byte big-endian MessagePack frames", () => {
    const frame = encodeNativeTuiFrame(handshake);
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    expect(decodeNativeTuiFrame(frame)).toEqual(handshake);
  });

  test("incremental decoder handles split and coalesced frames", () => {
    const first = encodeNativeTuiFrame(handshake);
    const second = encodeNativeTuiFrame(snapshot);
    const decoder = new NativeTuiFrameDecoder();
    expect(decoder.push(first.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([first.subarray(3), second]))).toEqual([
      handshake,
      snapshot,
    ]);
  });

  test("rejects unknown fields, wrong versions, malformed values, and oversized frames", () => {
    expect(() =>
      validateNativeTuiMessage({ ...handshake, extra: true }),
    ).toThrow(NativeTuiProtocolError);
    expect(() =>
      validateNativeTuiMessage({ ...handshake, version: 2 }),
    ).toThrow(NativeTuiProtocolError);
    expect(() =>
      validateNativeTuiMessage({
        ...handshake,
        capabilities: Array.from({ length: 65 }, () => "cap"),
      }),
    ).toThrow(NativeTuiProtocolError);
    expect(() =>
      validateNativeTuiMessage({
        ...snapshot,
        tasks: Array.from({ length: NATIVE_TUI_MAX_TASKS + 1 }, (_, index) => ({
          id: `task-${index}`,
          title: "task",
          status: "pending",
        })),
      }),
    ).toThrow(NativeTuiProtocolError);
    const tooLarge = Buffer.alloc(4);
    tooLarge.writeUInt32BE(NATIVE_TUI_MAX_FRAME_BYTES + 1, 0);
    expect(() => decodeNativeTuiFrame(tooLarge)).toThrow(
      NativeTuiProtocolError,
    );
  });

  test("rejects trailing bytes and zero-length frames", () => {
    const frame = encodeNativeTuiFrame(handshake);
    expect(() => decodeNativeTuiFrame(Buffer.concat([frame, frame]))).toThrow(
      NativeTuiProtocolError,
    );
    const zero = Buffer.alloc(4);
    expect(() => decodeNativeTuiFrame(zero)).toThrow(NativeTuiProtocolError);
  });

  test("validates the Rust serde-tagged input event shapes", () => {
    const input = {
      type: "input_event" as const,
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: "input-1",
      sequence: 1,
      event: { type: "key" as const, key: "c", modifiers: ["ctrl"] },
    };
    expect(decodeNativeTuiFrame(encodeNativeTuiFrame(input))).toEqual(input);
    expect(() =>
      validateNativeTuiMessage({
        ...input,
        event: { type: "submit", extra: 1 },
      }),
    ).toThrow(NativeTuiProtocolError);
  });

  test("does not accept arbitrary MessagePack values", () => {
    const payload = Buffer.from(encode({ type: "handshake", version: 1 }));
    const frame = Buffer.alloc(payload.byteLength + 4);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, 4);
    expect(() => decodeNativeTuiFrame(frame)).toThrow(NativeTuiProtocolError);
  });
});
