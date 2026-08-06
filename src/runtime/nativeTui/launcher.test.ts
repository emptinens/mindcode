import { describe, expect, test } from "bun:test";
import type { NativeTuiFeatureGate } from "./featureGate.js";
import {
  NativeTuiLaunchCoordinator,
  type NativeTuiSessionLike,
  createNativeTuiLaunchCoordinator,
  launchNativeTuiWithFallback,
} from "./launcher.js";
import type { NativeTuiSessionLaunchResult } from "./launcher.js";

const enabledGate: NativeTuiFeatureGate = {
  enabled: true,
  mode: "auto",
  requestedMode: "auto",
  platform: "darwin",
  platformSupported: true,
  stdinIsTTY: true,
  stdoutIsTTY: true,
  capability: true,
  reason: "enabled",
};

function disabledGate(
  reason: NativeTuiFeatureGate["reason"] = "explicit-off",
): NativeTuiFeatureGate {
  return { ...enabledGate, enabled: false, mode: "off", reason };
}

class SessionFixture implements NativeTuiSessionLike {
  readonly result: NativeTuiSessionLaunchResult;
  launches = 0;
  closes = 0;
  constructor(result: NativeTuiSessionLaunchResult) {
    this.result = result;
  }
  async launch(): Promise<NativeTuiSessionLaunchResult> {
    this.launches += 1;
    return this.result;
  }
  async close(): Promise<void> {
    this.closes += 1;
  }
}

describe("bounded native TUI launch coordinator", () => {
  test("does not construct a session when the auto gate is disabled", async () => {
    let constructed = 0;
    const result = await launchNativeTuiWithFallback({
      gate: disabledGate("stdin-not-tty"),
      createSession: () => {
        constructed += 1;
        throw new Error("must not construct");
      },
    });

    expect(result).toMatchObject({
      source: "fallback",
      kind: "ink-fallback",
      reason: "stdin-not-tty",
    });
    expect(constructed).toBe(0);
  });

  test("mode=on remains a typed fallback on unsupported interactive input", async () => {
    const result = await launchNativeTuiWithFallback({
      gate: {
        ...disabledGate("unsupported-platform"),
        mode: "on",
        requestedMode: "on",
        platform: "win32",
        platformSupported: false,
      },
    });

    expect(result.source).toBe("fallback");
    if (result.source === "fallback") {
      expect(result.reason).toBe("unsupported-platform");
      expect(result.gate.mode).toBe("on");
    }
  });

  test("returns native session and closes it exactly once", async () => {
    const session = new SessionFixture({
      source: "native-tui",
      session: {} as NativeTuiSessionLike,
    });
    const coordinator = new NativeTuiLaunchCoordinator({
      gate: enabledGate,
      createSession: () => session,
    });

    const result = await coordinator.launch();
    expect(result).toMatchObject({ source: "native-tui", kind: "native-tui" });
    expect(session.launches).toBe(1);
    await coordinator.close();
    await coordinator.close();
    expect(session.closes).toBe(1);
    expect(coordinator.state).toBe("closed");
  });

  test("converts missing binary/session startup failures to Ink fallback", async () => {
    const session = new SessionFixture({
      source: "fallback",
      reason: "missing_binary",
      error: new Error("missing"),
    });
    const result = await launchNativeTuiWithFallback({
      gate: enabledGate,
      createSession: () => session,
    });

    expect(result).toMatchObject({
      source: "fallback",
      reason: "missing_binary",
      error: new Error("missing"),
    });
    expect(session.closes).toBe(1);
  });

  test("bounds a hung handshake and closes the session", async () => {
    const session: NativeTuiSessionLike = {
      async launch(): Promise<NativeTuiSessionLaunchResult> {
        return new Promise(() => undefined);
      },
      async close(): Promise<void> {
        closeCalls += 1;
      },
    };
    let closeCalls = 0;
    const result = await launchNativeTuiWithFallback({
      gate: enabledGate,
      createSession: () => session,
      launchTimeoutMs: 5,
    });

    expect(result).toMatchObject({
      source: "fallback",
      reason: "handshake_timeout",
    });
    expect(closeCalls).toBe(1);
  });

  test("supports deterministic timer hooks without waiting for wall clock", async () => {
    let fireTimeout: (() => void) | undefined;
    let clearCalls = 0;
    const session: NativeTuiSessionLike = {
      launch: () => new Promise(() => undefined),
      close: async () => undefined,
    };
    const promise = createNativeTuiLaunchCoordinator({
      gate: enabledGate,
      createSession: () => session,
      launchTimeoutMs: 100,
      setTimeout: (callback: () => void) => {
        fireTimeout = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {
        clearCalls += 1;
      },
    }).launch();
    await Bun.sleep(0);
    fireTimeout?.();
    const result = await promise;

    expect(result).toMatchObject({
      source: "fallback",
      reason: "handshake_timeout",
    });
    expect(clearCalls).toBe(1);
  });

  test("close before launch returns a typed coordinator fallback", async () => {
    const coordinator = createNativeTuiLaunchCoordinator({ gate: enabledGate });
    await coordinator.close();
    const result = await coordinator.launch();
    expect(result).toMatchObject({
      source: "fallback",
      reason: "coordinator-closed",
    });
  });
});
