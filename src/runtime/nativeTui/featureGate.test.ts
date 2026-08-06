import { describe, expect, test } from "bun:test";
import {
  isNativeTuiEnabled,
  resolveNativeTuiFeatureGate,
} from "./featureGate.js";

const interactive = {
  platform: "darwin",
  stdinIsTTY: true,
  stdoutIsTTY: true,
};

describe("native TUI feature gate", () => {
  test("enables auto deterministically on a supported interactive terminal", () => {
    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { TERM: "xterm-256color" },
      }),
    ).toMatchObject({
      enabled: true,
      mode: "auto",
      reason: "enabled",
      platformSupported: true,
      capability: true,
    });
  });

  test("off wins over every platform, TTY, and capability signal", () => {
    expect(
      resolveNativeTuiFeatureGate({
        env: { MINDCODE_NATIVE_TUI: "off", TERM: "dumb" },
        platform: "win32",
        stdinIsTTY: false,
        stdoutIsTTY: false,
        capabilities: { nativeTui: false },
      }),
    ).toMatchObject({ enabled: false, mode: "off", reason: "explicit-off" });
  });

  test("on still requires a supported platform and both TTY streams", () => {
    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { MINDCODE_NATIVE_TUI: "on" },
        stdinIsTTY: false,
      }),
    ).toMatchObject({ enabled: false, mode: "on", reason: "stdin-not-tty" });

    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { MINDCODE_NATIVE_TUI: "on" },
        platform: "win32",
      }),
    ).toMatchObject({ enabled: false, reason: "unsupported-platform" });
  });

  test("auto disables on a dumb terminal or explicit capability failure", () => {
    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { TERM: "dumb" },
      }),
    ).toMatchObject({ enabled: false, reason: "insufficient-capability" });

    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        capabilities: { nativeTui: false },
      }),
    ).toMatchObject({ enabled: false, reason: "insufficient-capability" });
  });

  test("normalizes the environment value and falls back to auto", () => {
    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { MINDCODE_NATIVE_TUI: " ON ", TERM: "xterm" },
      }).mode,
    ).toBe("on");
    expect(
      resolveNativeTuiFeatureGate({
        ...interactive,
        env: { MINDCODE_NATIVE_TUI: "unexpected", TERM: "xterm" },
      }),
    ).toMatchObject({ enabled: true, mode: "auto", requestedMode: "auto" });
  });

  test("boolean helper uses exactly the same resolution", () => {
    expect(isNativeTuiEnabled({ ...interactive, env: { TERM: "xterm" } })).toBe(
      true,
    );
    expect(
      isNativeTuiEnabled({
        ...interactive,
        env: { MINDCODE_NATIVE_TUI: "off" },
      }),
    ).toBe(false);
  });
});
