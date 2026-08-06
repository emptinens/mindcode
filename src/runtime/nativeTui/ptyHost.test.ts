import { describe, expect, test } from "bun:test";
import type { PtyHandle } from "../../utils/pty/ptyBackend.js";
import {
  type NativeTuiByteInput,
  NativeTuiPtyHost,
  sanitizeNativeTuiEnvironment,
} from "./ptyHost.js";

class InputFixture implements NativeTuiByteInput {
  readonly listeners = new Set<(chunk: unknown) => void>();
  isRaw = false;
  on(_event: "data", listener: (chunk: unknown) => void): this {
    this.listeners.add(listener);
    return this;
  }
  removeListener(_event: "data", listener: (chunk: unknown) => void): this {
    this.listeners.delete(listener);
    return this;
  }
  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }
  emit(chunk: unknown): void {
    for (const listener of this.listeners) listener(chunk);
  }
}

class PtyFixture implements PtyHandle {
  pid = 42;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  killed = 0;
  dataListeners = new Set<(data: string) => void>();
  exitListeners = new Set<
    (event: { exitCode: number; signal?: number }) => void
  >();
  disposed = 0;
  onData(listener: (data: string) => void): { dispose: () => void } {
    this.dataListeners.add(listener);
    return {
      dispose: () => {
        this.dataListeners.delete(listener);
        this.disposed += 1;
      },
    };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): {
    dispose: () => void;
  } {
    this.exitListeners.add(listener);
    return {
      dispose: () => {
        this.exitListeners.delete(listener);
        this.disposed += 1;
      },
    };
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed += 1;
    queueMicrotask(() => this.emitExit(-1));
  }
  emitOutput(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(exitCode: number): void {
    for (const listener of this.exitListeners) listener({ exitCode });
  }
}

describe("native TUI PTY host", () => {
  test("forwards output and attached input bytewise, resizes, and cleans up once", async () => {
    const input = new InputFixture();
    const pty = new PtyFixture();
    const output: Uint8Array[] = [];
    const host = new NativeTuiPtyHost({
      executablePath: "/tmp/mindcode-tui",
      args: ["--test"],
      stdin: input,
      stdout: { write: (chunk) => output.push(chunk) },
      spawn: async (file, args, options) => {
        expect(file).toBe("/tmp/mindcode-tui");
        expect(args).toEqual(["--test"]);
        expect(options.name).toBe("xterm-256color");
        return pty;
      },
    });

    await host.start();
    host.attachInput();
    input.emit(Buffer.from([0x1b, 0x5b, 0x41]));
    pty.emitOutput("ok\n");
    host.resize(100, 30);
    expect(pty.writes).toEqual(["\u001b[A"]);
    expect(Buffer.from(output[0] ?? []).toString()).toBe("ok\n");
    expect(pty.resizes).toEqual([[100, 30]]);

    host.detachInput();
    await Promise.all([host.close(), host.close()]);
    expect(pty.killed).toBe(1);
    expect(pty.disposed).toBe(2);
    expect(input.listeners.size).toBe(0);
  });

  test("does not pass secret environment variables to the native process", () => {
    const env = sanitizeNativeTuiEnvironment(
      { PATH: "/bin", VEXZY_API_KEY: "secret", MINDCODE_API_TOKEN: "secret" },
      { TERM: "xterm", HOME: "/tmp" },
    );
    expect(env).toEqual({ PATH: "/bin", TERM: "xterm", HOME: "/tmp" });
  });

  test("closes a PTY whose async spawn resolves after shutdown starts", async () => {
    const pty = new PtyFixture();
    let resolveSpawn!: (value: PtyHandle) => void;
    const spawn = new Promise<PtyHandle>((resolve) => {
      resolveSpawn = resolve;
    });
    const host = new NativeTuiPtyHost({
      executablePath: "/tmp/mindcode-tui",
      spawn: () => spawn,
      shutdownTimeoutMs: 10,
    });
    const starting = host.start();
    const closing = host.close();
    resolveSpawn(pty);
    await expect(starting).rejects.toThrow("closed during startup");
    await closing;
    expect(host.state).toBe("closed");
    expect(pty.killed).toBe(1);
    expect(pty.disposed).toBe(2);
  });
});
