import { describe, expect, test } from "bun:test";
import { encode } from "@msgpack/msgpack";
import {
  NATIVE_TUI_MAX_FRAME_BYTES,
  NATIVE_TUI_MAX_SESSIONS,
  NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS,
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
  client: "mindcode-tui",
  capabilities: ["render_snapshot_v2", "input", "mouse"],
};

const telemetry = {
  connection: { state: "connected", reconnect_attempts: 0 },
  model: "gpt-5.6-luna",
  effort: "high",
  context_used_tokens: 1,
  context_limit_tokens: 1_100_000,
  input_tokens: 1,
  output_tokens: 2,
  cached_tokens: 0,
  reasoning_tokens: 1,
  credits: 4.419,
  active_agents: 1,
  queued_tasks: 0,
  api_requests: 1,
  latency_ms: 2,
};

const snapshot = {
  type: "render_snapshot" as const,
  version: NATIVE_TUI_PROTOCOL_VERSION,
  id: "session-1",
  sequence: 4,
  sessions: [
    {
      id: "session-1",
      name: "MindCode",
      workspace: "/workspace",
      status: "active",
      model: "gpt-5.6-luna",
      effort: "high",
      active: true,
      pinned: true,
      unread: 0,
      created_at_ms: 1,
      updated_at_ms: 2,
    },
  ],
  workspaces: [
    { id: "workspace-1", name: "MindCode", path: "/workspace", active: true },
  ],
  active_session_id: "session-1",
  status: { state: "running", message: "working" },
  telemetry,
  tasks: [
    {
      id: "task-1",
      title: "Build",
      status: "running",
      progress: 50,
      metadata: {
        owner: "leader",
        agent_id: "agent-1",
        model: "gpt-5.6-luna",
        effort: "high",
        dependencies: [],
        blocked_by: [],
        files_touched: ["src/runtime/nativeTui/protocol.ts"],
        isolation: "shared",
      },
    },
  ],
  agents: [
    {
      id: "agent-1",
      name: "Luna",
      role: "worker",
      status: "running",
      task_id: "task-1",
      model: "gpt-5.6-luna",
      effort: "high",
      progress: 50,
    },
  ],
  transcript: [
    {
      type: "markdown" as const,
      id: "message-1",
      sequence: 1,
      role: "assistant",
      text: "done",
    },
    {
      type: "code" as const,
      id: "code-1",
      sequence: 2,
      role: "assistant",
      language: "typescript",
      code: "export const ok = true;",
    },
    {
      type: "tool" as const,
      id: "tool-1",
      sequence: 3,
      name: "bun",
      status: "done",
      input: "test",
      output: "ok",
      duration_ms: 10,
    },
    {
      type: "thinking" as const,
      id: "thinking-1",
      sequence: 4,
      summary: "plan",
      effort: "high",
      elapsed_ms: 1,
      tokens_used: 1,
    },
    {
      type: "report" as const,
      id: "report-1",
      sequence: 5,
      task_id: "task-1",
      status: "completed",
      summary: "done",
      changed_files: ["src/runtime/nativeTui/protocol.ts"],
      evidence: ["bun test"],
      tokens_used: 1,
      effort_used: "high",
    },
    {
      type: "error" as const,
      id: "error-1",
      sequence: 6,
      code: "warning",
      message: "retrying",
      recoverable: true,
    },
  ],
  transcript_window: {
    start_sequence: 1,
    end_sequence: 6,
    has_older: false,
    has_newer: false,
    blocks: [],
  },
  changes: [
    {
      path: "src/runtime/nativeTui/protocol.ts",
      kind: "modified",
      additions: 1,
      deletions: 0,
      staged: false,
      language: "typescript",
      diff: "+export const version = 2;",
    },
  ],
  activity: [
    {
      id: "activity-1",
      timestamp_ms: 1,
      kind: "task_completed",
      message: "done",
      task_id: "task-1",
      agent_id: "agent-1",
      severity: "info",
    },
  ],
  permissions: [
    {
      id: "permission-1",
      tool: "Bash",
      action: "run",
      resource: "bun test",
      reason: "verification",
      status: "pending",
      requested_at_ms: 1,
      task_id: "task-1",
      agent_id: "agent-1",
    },
  ],
  writer: { mode: "writer", writer_id: "client-1", observers: ["client-2"] },
};

describe("native TUI protocol v2", () => {
  test("round-trips the complete rich v2 snapshot", () => {
    const frame = encodeNativeTuiFrame(snapshot);
    expect(frame.readUInt32BE(0)).toBe(frame.byteLength - 4);
    expect(decodeNativeTuiFrame(frame)).toEqual(snapshot);
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

  test("rejects an oversized aggregate chunk before Buffer.concat", () => {
    const decoder = new NativeTuiFrameDecoder(32);
    expect(decoder.push(Uint8Array.of(0, 0, 0, 32, 0))).toEqual([]);
    const state = decoder as unknown as { buffered: Buffer };
    const bufferedBeforeReject = state.buffered;

    expect(() => decoder.push(new Uint8Array(32))).toThrow(
      "Buffered frame exceeds the maximum size",
    );
    expect(state.buffered).toBe(bufferedBeforeReject);
  });

  test("rejects inverted code line ranges like Rust protocol v2", () => {
    const malformed = {
      ...snapshot,
      transcript: snapshot.transcript.map((block, index) =>
        index === 1 ? { ...block, start_line: 8, end_line: 3 } : block,
      ),
    };
    expect(() => validateNativeTuiMessage(malformed)).toThrow(
      "start line must not exceed end line",
    );
  });

  test("validates mouse and action input variants", () => {
    const mouse = {
      type: "input_event" as const,
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: "mouse-1",
      sequence: 1,
      event: {
        type: "mouse" as const,
        x: 12,
        y: 4,
        button: "left" as const,
        kind: "down" as const,
        modifiers: ["shift"],
      },
    };
    const action = {
      type: "input_event" as const,
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: "action-1",
      sequence: 2,
      event: { type: "action" as const, action: "open_inspector", target: "task-1" },
    };
    expect(decodeNativeTuiFrame(encodeNativeTuiFrame(mouse))).toEqual(mouse);
    expect(decodeNativeTuiFrame(encodeNativeTuiFrame(action))).toEqual(action);
  });

  test("round-trips acknowledgement, error, and shutdown control messages", () => {
    const messages = [
      {
        type: "ack" as const,
        version: NATIVE_TUI_PROTOCOL_VERSION,
        id: "input-1",
        sequence: 7,
      },
      {
        type: "error" as const,
        version: NATIVE_TUI_PROTOCOL_VERSION,
        id: "input-2",
        code: "handshake_rejected",
        message: "Handshake rejected",
        details: "capability mismatch",
      },
      {
        type: "shutdown" as const,
        version: NATIVE_TUI_PROTOCOL_VERSION,
        id: "session-1",
        reason: "complete",
      },
    ];
    for (const message of messages) {
      expect(decodeNativeTuiFrame(encodeNativeTuiFrame(message))).toEqual(
        message,
      );
    }
  });

  test("rejects unknown fields, wrong versions, malformed values, and limits", () => {
    expect(() => validateNativeTuiMessage({ ...handshake, extra: true })).toThrow(
      NativeTuiProtocolError,
    );
    expect(() => validateNativeTuiMessage({ ...handshake, version: 1 })).toThrow(
      NativeTuiProtocolError,
    );
    expect(() => validateNativeTuiMessage({ ...snapshot, sessions: Array.from({ length: NATIVE_TUI_MAX_SESSIONS + 1 }, () => snapshot.sessions[0]) })).toThrow(NativeTuiProtocolError);
    expect(() => validateNativeTuiMessage({ ...snapshot, transcript: Array.from({ length: NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS + 1 }, () => snapshot.transcript[0]) })).toThrow(NativeTuiProtocolError);
    expect(() => validateNativeTuiMessage({ ...snapshot, telemetry: { ...snapshot.telemetry, context_used_tokens: 2_000_000 } })).toThrow(NativeTuiProtocolError);
    expect(() => validateNativeTuiMessage({ ...snapshot, transcript: [{ ...snapshot.transcript[0], unexpected: true }] })).toThrow(NativeTuiProtocolError);
    const tooLarge = Buffer.alloc(4);
    tooLarge.writeUInt32BE(NATIVE_TUI_MAX_FRAME_BYTES + 1, 0);
    expect(() => decodeNativeTuiFrame(tooLarge)).toThrow(NativeTuiProtocolError);
  });

  test("rejects trailing bytes and zero-length frames", () => {
    const frame = encodeNativeTuiFrame(handshake);
    expect(() => decodeNativeTuiFrame(Buffer.concat([frame, frame]))).toThrow(
      NativeTuiProtocolError,
    );
    const zero = Buffer.alloc(4);
    expect(() => decodeNativeTuiFrame(zero)).toThrow(NativeTuiProtocolError);
  });

  test("does not accept arbitrary MessagePack values", () => {
    const payload = Buffer.from(encode({ type: "handshake", version: 2 }));
    const frame = Buffer.alloc(payload.byteLength + 4);
    frame.writeUInt32BE(payload.byteLength, 0);
    payload.copy(frame, 4);
    expect(() => decodeNativeTuiFrame(frame)).toThrow(NativeTuiProtocolError);
  });
});
