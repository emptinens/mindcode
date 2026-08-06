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
  NATIVE_TUI_MAX_STATUS_BYTES,
  NATIVE_TUI_MAX_TASKS,
  NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
} from "./protocol.js";

describe("native TUI bounded projections", () => {
  test("projects only bounded status fields and redacts credential-shaped text", () => {
    expect(
      projectStatus({
        state: "running",
        message: "Bearer forge-secret api_key=hidden",
        detail: "private",
      }),
    ).toEqual({
      state: "running",
      message: "Bearer [redacted] api_key=[redacted]",
      detail: "private",
    });
  });

  test("bounds tasks and rejects invalid progress", () => {
    const tasks = projectTasks(
      Array.from({ length: NATIVE_TUI_MAX_TASKS + 5 }, (_, index) => ({
        id: `task-${index}`,
        title: `Task ${index}`,
        status: "pending",
      })),
    );
    expect(tasks).toHaveLength(NATIVE_TUI_MAX_TASKS);
    expect(tasks.at(-1)?.id).toBe(`task-${NATIVE_TUI_MAX_TASKS - 1}`);
    expect(() =>
      projectTasks([
        { id: "task", title: "task", status: "running", progress: 101 },
      ]),
    ).toThrow();
  });

  test("drops raw tool entries, keeps transcript order, and bounds text", () => {
    const entries = projectTranscript([
      { sequence: 1, role: "tool", text: "raw tool output secret" },
      { sequence: 2, role: "user", text: "hello" },
      {
        sequence: 3,
        role: "assistant",
        text: `x=${"x".repeat(NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES + 10)}`,
      },
    ]);
    expect(entries.map((entry) => entry.sequence)).toEqual([2, 3]);
    expect(entries[1]?.text.length).toBeLessThanOrEqual(
      NATIVE_TUI_MAX_TRANSCRIPT_TEXT_BYTES,
    );
  });

  test("truncates at a UTF-8 code-point boundary", () => {
    const value = `${"a".repeat(NATIVE_TUI_MAX_STATUS_BYTES - 1)}😀`;
    const projected = projectStatus({ state: "ready", message: value });
    expect(projected.message).toBe("a".repeat(NATIVE_TUI_MAX_STATUS_BYTES - 1));
    expect(
      new TextEncoder().encode(projected.message ?? "").byteLength,
    ).toBeLessThanOrEqual(NATIVE_TUI_MAX_STATUS_BYTES);
    expect(projected.message).not.toContain("�");
  });

  test("enforces an aggregate snapshot budget before retention", () => {
    const snapshot = projectRenderSnapshot("session-1", 1, {
      status: { state: "ready" },
      tasks: Array.from({ length: 500 }, (_, index) => ({
        id: `task-${index}`,
        title: "x".repeat(4_096),
        status: "pending",
      })),
      transcript: Array.from({ length: 20 }, (_, index) => ({
        sequence: index,
        role: "assistant",
        text: "z".repeat(64_000),
      })),
    });
    expect(nativeTuiSnapshotByteLength(snapshot)).toBeLessThanOrEqual(
      NATIVE_TUI_MAX_SNAPSHOT_BYTES,
    );
    expect(snapshot.tasks.length).toBe(500);
  });

  test("rejects snapshots whose status and task data exceed the aggregate budget", () => {
    expect(() =>
      projectRenderSnapshot("session-1", 1, {
        status: { state: "ready" },
        tasks: Array.from({ length: NATIVE_TUI_MAX_TASKS }, (_, index) => ({
          id: `task-${index}`,
          title: "x".repeat(4_096),
          status: "pending",
          detail: "y".repeat(4_096),
        })),
      }),
    ).toThrow(/aggregate/);
  });

  test("does not advance the revision when aggregate projection fails", () => {
    const store = new NativeTuiProjectionStore("session-1");
    expect(() =>
      store.update({
        status: { state: "ready" },
        tasks: Array.from({ length: NATIVE_TUI_MAX_TASKS }, (_, index) => ({
          id: `task-${index}`,
          title: "x".repeat(4_096),
          status: "pending",
          detail: "y".repeat(4_096),
        })),
      }),
    ).toThrow(/aggregate/);
    expect(store.revision).toBe(0);
    expect(store.update({ status: { state: "ready" } }).sequence).toBe(1);
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
    expect(() =>
      projectRenderSnapshot("", 1, { status: { state: "ready" } }),
    ).toThrow();
  });
});
