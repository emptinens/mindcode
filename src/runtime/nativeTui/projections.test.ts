import { describe, expect, test } from "bun:test";
import {
  NativeTuiProjectionStore,
  NativeTuiRevisionClock,
  nativeTuiSnapshotByteLength,
  projectRenderSnapshot,
  projectStatus,
  projectTasks,
  projectTranscript,
} from "./projections.js";
import {
  NATIVE_TUI_MAX_SNAPSHOT_BYTES,
  NATIVE_TUI_MAX_TASKS,
  NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS,
  NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
  validateNativeTuiMessage,
} from "./protocol.js";

describe("native TUI v2 bounded projections", () => {
  test("projects defaults for rich fields and redacts credential-shaped text", () => {
    const snapshot = projectRenderSnapshot("session-1", 1, {
      status: {
        state: "running",
        message: "Bearer forge-secret api_key=hidden",
      },
    });
    expect(snapshot.active_session_id).toBe("session-1");
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.workspaces).toEqual([]);
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.permissions).toEqual([]);
    expect(snapshot.writer).toEqual({ mode: "observer", observers: [] });
    expect(snapshot.telemetry.model).toBe("gpt-5.6-luna");
    expect(snapshot.telemetry.context_limit_tokens).toBeGreaterThan(0);
    expect(snapshot.status.message).toBe(
      "Bearer [redacted] api_key=[redacted]",
    );
    expect(validateNativeTuiMessage(snapshot)).toEqual(snapshot);
  });

  test("keeps task hierarchy metadata and enforces strict bounds", () => {
    const task = projectTasks([
      {
        id: "task-1",
        title: "Build",
        status: "running",
        parent_id: "root",
        owner: "leader",
        agent_id: "agent-1",
        model: "gpt-5.6-luna",
        effort: "high",
        dependencies: ["task-0"],
        blocked_by: ["task-0"],
        files_touched: ["src/a.ts"],
        isolation: "worktree",
        progress: 50,
      },
    ]);
    expect(task[0]?.metadata).toEqual({
      parent_id: "root",
      owner: "leader",
      agent_id: "agent-1",
      model: "gpt-5.6-luna",
      effort: "high",
      dependencies: ["task-0"],
      blocked_by: ["task-0"],
      files_touched: ["src/a.ts"],
      isolation: "worktree",
    });
    expect(() =>
      projectTasks(
        Array.from({ length: NATIVE_TUI_MAX_TASKS + 1 }, (_, index) => ({
          id: `task-${index}`,
        })),
      ),
    ).toThrow();
    expect(() =>
      projectTasks([{ id: "task", progress: 101 }]),
    ).toThrow();
  });

  test("projects typed markdown/code/tool/thinking/report/error blocks", () => {
    const blocks = projectTranscript([
      { sequence: 1, role: "tool", text: "raw tool output" },
      { sequence: 2, role: "user", text: "hello" },
      {
        type: "code",
        id: "code-1",
        sequence: 3,
        role: "assistant",
        language: "ts",
        code: "api_key=hidden",
      },
      {
        type: "tool",
        id: "tool-1",
        sequence: 4,
        name: "Bash",
        status: "done",
        output: "Bearer forge-hidden",
      },
      {
        type: "thinking",
        id: "thinking-1",
        sequence: 5,
        summary: "plan",
        effort: "medium",
        elapsed_ms: 1,
        tokens_used: 2,
      },
      {
        type: "report",
        id: "report-1",
        sequence: 6,
        task_id: "task-1",
        status: "completed",
        summary: "done",
        changed_files: ["src/a.ts"],
        evidence: ["bun test"],
        tokens_used: 2,
        effort_used: "medium",
      },
      {
        type: "error",
        id: "error-1",
        sequence: 7,
        code: "retry",
        message: "retrying",
        recoverable: true,
      },
    ]);
    expect(blocks.map((block) => block.type)).toEqual([
      "markdown",
      "code",
      "tool",
      "thinking",
      "report",
      "error",
    ]);
    expect(blocks[0]).toMatchObject({ sequence: 2, role: "user" });
    expect(blocks[1]).toMatchObject({ code: "api_key=[redacted]" });
    expect(blocks[2]).toMatchObject({ output: "Bearer [redacted]" });
  });

  test("rejects inverted code block line ranges before wire validation", () => {
    const invertedCodeBlock = {
      type: "code" as const,
      id: "code-inverted",
      sequence: 1,
      role: "assistant",
      language: "typescript",
      code: "const value = true;",
      start_line: 8,
      end_line: 3,
    };

    expect(() => projectTranscript([invertedCodeBlock])).toThrow(
      "start line must not exceed end line",
    );
  });

  test("bounds typed transcript blocks and truncates at a UTF-8 boundary", () => {
    expect(() =>
      projectTranscript(
        Array.from({ length: NATIVE_TUI_MAX_TRANSCRIPT_BLOCKS + 1 }, (_, index) => ({
          type: "markdown" as const,
          id: `message-${index}`,
          sequence: index,
          role: "assistant",
          text: "ok",
        })),
      ),
    ).toThrow();
    const value = `${"a".repeat(NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES - 1)}😀`;
    const projected = projectTranscript([{ sequence: 1, role: "assistant", text: value }]);
    expect(projected[0]).toMatchObject({
      text: "a".repeat(NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES - 1),
    });
    const first = projected[0];
    if (!first || first.type !== "markdown") {
      throw new Error("expected a markdown transcript block");
    }
    expect(first.text).not.toContain("�");
  });

  test("enforces the aggregate snapshot budget before transcript retention", () => {
    const snapshot = projectRenderSnapshot("session-1", 1, {
      tasks: Array.from({ length: 500 }, (_, index) => ({
        id: `task-${index}`,
        title: "x".repeat(4_096),
        status: "pending",
      })),
      transcript: Array.from({ length: 20 }, (_, index) => ({
        type: "markdown" as const,
        id: `message-${index}`,
        sequence: index,
        role: "assistant",
        text: "z".repeat(64_000),
      })),
    });
    expect(nativeTuiSnapshotByteLength(snapshot)).toBeLessThanOrEqual(
      NATIVE_TUI_MAX_SNAPSHOT_BYTES,
    );
    expect(snapshot.tasks).toHaveLength(500);
    expect(snapshot.transcript.length).toBeLessThan(20);
  });

  test("rejects snapshots whose fixed rich data exceeds the aggregate budget", () => {
    expect(() =>
      projectRenderSnapshot("session-1", 1, {
        tasks: Array.from({ length: NATIVE_TUI_MAX_TASKS }, (_, index) => ({
          id: `task-${index}`,
          title: "x".repeat(4_096),
          status: "pending",
          files_touched: ["y".repeat(2_048)],
        })),
      }),
    ).toThrow(/aggregate/);
  });

  test("does not advance the revision when aggregate projection fails", () => {
    const store = new NativeTuiProjectionStore("session-1");
    expect(() =>
      store.update({
        tasks: Array.from({ length: NATIVE_TUI_MAX_TASKS }, (_, index) => ({
          id: `task-${index}`,
          title: "x".repeat(4_096),
          status: "pending",
          files_touched: ["y".repeat(2_048)],
        })),
      }),
    ).toThrow(/aggregate/);
    expect(store.revision).toBe(0);
    expect(store.update({}).sequence).toBe(1);
  });

  test("owns monotonic snapshot revisions in TypeScript", () => {
    const store = new NativeTuiProjectionStore("session-1");
    const first = store.update({ status: { state: "ready" } });
    const second = store.update({ status: { state: "running" } });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(store.revision).toBe(2);
    expect(store.snapshot).toEqual(second);
  });

  test("rejects revision overflow and invalid projection identifiers", () => {
    expect(() =>
      new NativeTuiRevisionClock(Number.MAX_SAFE_INTEGER).next(),
    ).toThrow();
    expect(() => projectRenderSnapshot("", 1, {})).toThrow();
  });
});
