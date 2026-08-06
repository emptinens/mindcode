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
    expect(chunks.join("")).toBe("q\u0003\r");
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
});
