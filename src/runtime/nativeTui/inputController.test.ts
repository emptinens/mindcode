import { describe, expect, test } from "bun:test";
import { NativeTuiInputController } from "./inputController.js";
import {
  NATIVE_TUI_PROTOCOL_VERSION,
  type NativeTuiInputEvent,
} from "./protocol.js";

function event(sequence: number, text: string): NativeTuiInputEvent {
  return {
    type: "input_event",
    version: NATIVE_TUI_PROTOCOL_VERSION,
    id: `input-${sequence}`,
    sequence,
    event: { type: "text", text },
  };
}

describe("native TUI input controller", () => {
  test("serializes asynchronous input intents in sequence order", async () => {
    const seen: string[] = [];
    const controller = new NativeTuiInputController({
      onIntent: async (intent) => {
        await Bun.sleep(intent.sequence === 1 ? 10 : 0);
        seen.push(intent.event.type === "text" ? intent.event.text : "");
      },
    });
    const first = controller.accept(event(1, "one"));
    const second = controller.accept(event(2, "two"));
    await Promise.all([first, second]);
    expect(seen).toEqual(["one", "two"]);
    expect(controller.expectedSequence).toBe(3);
  });

  test("rejects duplicate and out-of-order sequences", () => {
    const controller = new NativeTuiInputController();
    expect(() => controller.accept(event(2, "two"))).toThrow();
    expect(controller.accept(event(1, "one"))).toBeInstanceOf(Promise);
    expect(() => controller.accept(event(1, "duplicate"))).toThrow();
  });

  test("keeps a failing intent isolated while preserving later ordering", async () => {
    const seen: number[] = [];
    const controller = new NativeTuiInputController({
      onIntent: (intent) => {
        seen.push(intent.sequence);
        if (intent.sequence === 1) throw new Error("input failed");
      },
    });
    const first = controller.accept(event(1, "one"));
    const second = controller.accept(event(2, "two"));
    await expect(first).rejects.toThrow("input failed");
    await second;
    expect(seen).toEqual([1, 2]);
  });

  test("creates TS-owned ordered intents and closes pending work", async () => {
    const controller = new NativeTuiInputController({
      onIntent: async () => Bun.sleep(20),
    });
    expect(controller.createIntent("one", { type: "submit" })).toEqual({
      type: "input_event",
      version: NATIVE_TUI_PROTOCOL_VERSION,
      id: "one",
      sequence: 1,
      event: { type: "submit" },
    });
    const active = controller.accept(event(1, "one"));
    const pending = controller.accept(event(2, "two"));
    controller.close();
    await expect(pending).rejects.toThrow("Input controller is closed");
    await active;
    expect(controller.isClosed).toBe(true);
    expect(() => controller.accept(event(2, "two"))).toThrow();
  });

  test("rejects input beyond the bounded pending queue", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = new NativeTuiInputController({
      maxPendingInputs: 2,
      onIntent: async () => blocked,
    });
    const first = controller.accept(event(1, "one"));
    const second = controller.accept(event(2, "two"));
    const third = controller.accept(event(3, "three"));
    expect(controller.pendingCount).toBe(2);
    expect(() => controller.accept(event(4, "four"))).toThrow(
      "Input controller queue is full",
    );
    release();
    await Promise.all([first, second, third]);
  });
});
