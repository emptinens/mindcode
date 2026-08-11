import { describe, expect, test } from "bun:test";
import type { AppState } from "../../state/AppStateStore.js";
import type { NativeTuiControlServer } from "./controlServer.js";
import { NativeTuiInkBridge } from "./inkBridge.js";
import {
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiInputEvent,
} from "./protocol.js";

describe("native TUI Ink bridge", () => {
  test("maps semantic input into the hidden Ink stdin", async () => {
    const published: unknown[] = [];
    const bridge = new NativeTuiInkBridge({
      publish: (value: unknown) => {
        published.push(value);
      },
    } as NativeTuiControlServer);
    const chunks: string[] = [];
    bridge.renderOptions.stdin?.on("data", (chunk) => {
      chunks.push(Buffer.from(chunk).toString());
    });
    for (const [sequence, event] of [
      [1, { type: "key", key: "q", modifiers: [] }],
      [2, { type: "key", key: "c", modifiers: ["ctrl"] }],
      [3, { type: "submit" }],
      [4, { type: "action", action: "new_session" }],
      [5, { type: "action", action: "attach_session" }],
      [6, { type: "action", action: "open_workspace" }],
      [7, { type: "action", action: "permission_decision", value: "once" }],
      [
        8,
        {
          type: "mouse",
          x: 2,
          y: 3,
          button: "left",
          kind: "down",
          modifiers: [],
        },
      ],
      [9, { type: "action", action: "request_control" }],
      [10, { type: "key", key: "up", modifiers: [] }],
      [11, { type: "key", key: "down", modifiers: [] }],
      [12, { type: "key", key: "left", modifiers: [] }],
      [13, { type: "key", key: "right", modifiers: [] }],
    ] as const) {
      bridge.handleInput({
        type: "input_event",
        version: NATIVE_TUI_PROTOCOL_VERSION,
        id: `input-${sequence}`,
        sequence,
        event,
      } as NativeTuiInputEvent);
    }
    await Bun.sleep(0);
    expect(chunks.join("")).toBe(
      "q\u0003\r/clear\r/resume\r/add-dir\ro\u001b[A\u001b[B\u001b[D\u001b[C",
    );
    bridge.close();
    expect(published).toEqual([]);
  });

  test("publishes bounded state and redacted terminal projection inputs", async () => {
    const published: unknown[] = [];
    const bridge = new NativeTuiInkBridge({
      publish: (value: unknown) => {
        published.push(value);
      },
    } as NativeTuiControlServer);
    bridge.publishState({
      tasks: {
        task: {
          id: "task",
          type: "local_agent",
          status: "running",
          description: "review",
        },
      } as unknown as AppState["tasks"],
      statusLineText: "active",
      mainLoopModel: "gpt-5.6-sol",
      effortValue: "high",
    });
    bridge.renderOptions.stdout?.write("\u001b[31mhello\u001b[0m");
    await Bun.sleep(1);
    expect(published.at(-1)).toMatchObject({
      status: { state: "working", message: "active" },
      sessions: [
        expect.objectContaining({
          model: "gpt-5.6-sol",
          effort: "high",
          active: true,
        }),
      ],
      workspaces: [expect.objectContaining({ active: true })],
      telemetry: expect.objectContaining({
        model: "gpt-5.6-sol",
        effort: "high",
        context_limit_tokens: expect.any(Number),
        credits: expect.any(Number),
      }),
      tasks: [{ id: "task", title: "review", status: "running" }],
      transcript: [{ role: "session", text: "hello" }],
    });
    bridge.close();
  });

  test("drops a rejected projection without crashing the hidden REPL", async () => {
    let attempts = 0;
    const bridge = new NativeTuiInkBridge({
      publish: () => {
        attempts += 1;
        throw new Error("projection rejected");
      },
    } as unknown as NativeTuiControlServer);

    bridge.publishState({
      tasks: {} as AppState["tasks"],
      statusLineText: "ready",
      mainLoopModel: "gpt-5.6-sol",
      effortValue: "medium",
    });
    await Bun.sleep(1);

    expect(attempts).toBe(1);
    bridge.close();
  });

  test("projects worker-owned model, effort, progress, typed messages, and report", async () => {
    const published: unknown[] = [];
    const bridge = new NativeTuiInkBridge({
      publish: (value: unknown) => {
        published.push(value);
      },
    } as NativeTuiControlServer);
    bridge.publishState({
      tasks: {
        shell: {
          id: "shell",
          type: "local_bash",
          status: "running",
          description: "shell",
        },
        worker: {
          id: "worker",
          type: "local_agent",
          agentId: "worker",
          agentType: "general-purpose",
          status: "running",
          description: "worker task",
          model: "gpt-5.6-luna",
          progress: { percentage: 37 },
          messages: [
            {
              type: "assistant",
              message: {
                content: [
                  { type: "text", text: "worker output" },
                  { type: "tool_use", name: "Read", input: { path: "a.ts" } },
                ],
              },
            },
            {
              type: "user",
              message: {
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "tool-1",
                    content: "file contents",
                  },
                ],
              },
            },
          ],
          result: {
            workerReport: {
              task_id: "worker",
              status: "completed",
              summary: "Worker report",
              changed_files: ["src/a.ts"],
              evidence: [
                { id: "worker-test", type: "test", command: "bun test" },
              ],
              tokens_used: 12,
              effort_used: "high",
              model: "gpt-5.6-luna",
            },
          },
        },
      } as unknown as AppState["tasks"],
      statusLineText: "working",
      mainLoopModel: "gpt-5.6-sol",
      effortValue: "max",
    });
    await Bun.sleep(1);

    expect(published.at(-1)).toMatchObject({
      tasks: expect.arrayContaining([
        expect.objectContaining({
          id: "worker",
          progress: 37,
          metadata: expect.objectContaining({
            model: "gpt-5.6-luna",
            effort: "high",
          }),
        }),
      ]),
      agents: [
        expect.objectContaining({
          id: "worker",
          model: "gpt-5.6-luna",
          effort: "high",
          progress: 37,
        }),
      ],
      telemetry: expect.objectContaining({ active_agents: 1 }),
      transcript: expect.arrayContaining([
        expect.objectContaining({ type: "markdown", text: "worker output" }),
        expect.objectContaining({ type: "tool", name: "Read" }),
        expect.objectContaining({ type: "report", task_id: "worker" }),
      ]),
    });
    bridge.close();
  });

  test("publishes connection disconnect and reconnect telemetry", async () => {
    const published: unknown[] = [];
    const bridge = new NativeTuiInkBridge({
      publish: (value: unknown) => {
        published.push(value);
      },
    } as NativeTuiControlServer);
    bridge.setConnectionState({
      state: "disconnected",
      reconnect_attempts: 2,
      last_error: "socket closed",
    });
    await Bun.sleep(1);
    expect(published.at(-1)).toMatchObject({
      telemetry: {
        connection: {
          state: "disconnected",
          reconnect_attempts: 2,
          last_error: "socket closed",
        },
      },
    });
    bridge.setConnectionState({ state: "connected", reconnect_attempts: 3 });
    await Bun.sleep(1);
    expect(published.at(-1)).toMatchObject({
      telemetry: {
        connection: { state: "connected", reconnect_attempts: 3 },
      },
    });
    bridge.close();
  });
});
