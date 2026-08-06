import { describe, expect, test } from "bun:test";
import { resolveNativeTuiExecutablePath } from "./path.js";

describe("native TUI executable resolution", () => {
  test("uses MINDCODE_NATIVE_TUI_PATH before packaged layouts", () => {
    expect(
      resolveNativeTuiExecutablePath(
        { MINDCODE_NATIVE_TUI_PATH: " /custom/mindcode-tui " },
        { runtimePath: "/bundle/mindcode", exists: () => true },
      ),
    ).toBe("/custom/mindcode-tui");
  });

  test("prefers the bundle sibling", () => {
    const seen: string[] = [];
    const result = resolveNativeTuiExecutablePath(
      {},
      {
        runtimePath: "/bundle/mindcode",
        platform: "darwin",
        arch: "arm64",
        exists: (path) => {
          seen.push(path);
          return path === "/bundle/mindcode-tui";
        },
      },
    );
    expect(result).toBe("/bundle/mindcode-tui");
    expect(seen).toEqual(["/bundle/mindcode-tui"]);
  });

  test("resolves target-qualified binaries and normalizes Rust architectures", () => {
    expect(
      resolveNativeTuiExecutablePath(
        {},
        {
          runtimePath: "/bundle/mindcode-linux-x64",
          platform: "linux",
          arch: "x86_64",
          exists: (path) => path.endsWith("mindcode-tui-linux-x64"),
        },
      ),
    ).toBe("/bundle/mindcode-tui-linux-x64");
  });

  test("keeps a deterministic bundle path when no binary exists", () => {
    expect(
      resolveNativeTuiExecutablePath(
        {},
        {
          runtimePath: "/bundle/mindcode",
          platform: "linux",
          arch: "aarch64",
          exists: () => false,
        },
      ),
    ).toBe("/bundle/mindcode-tui");
  });
});
