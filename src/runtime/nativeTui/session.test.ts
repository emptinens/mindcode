import { describe, expect, test } from "bun:test";
import type { NativeTuiControlServerOptions } from "./controlServer.js";
import type { NativeTuiPtyExit, NativeTuiPtyHostOptions } from "./ptyHost.js";
import type { NativeTuiByteInput, NativeTuiByteOutput } from "./ptyHost.js";
import {
  type NativeTuiControlServerLike,
  type NativeTuiPtyHostLike,
  NativeTuiSession,
} from "./session.js";

class InputFixture implements NativeTuiByteInput {
  isRaw = false;
  listeners = new Set<(chunk: unknown) => void>();
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

class OutputFixture implements NativeTuiByteOutput {
  chunks: Uint8Array[] = [];
  columns = 120;
  rows = 40;
  listeners = new Set<() => void>();
  write(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  on(_event: "resize", listener: () => void): this {
    this.listeners.add(listener);
    return this;
  }
  removeListener(_event: "resize", listener: () => void): this {
    this.listeners.delete(listener);
    return this;
  }
  resize(columns: number, rows: number): void {
    this.columns = columns;
    this.rows = rows;
    for (const listener of this.listeners) listener();
  }
}

class ControlFixture implements NativeTuiControlServerLike {
  readonly socketPath: string;
  connected = false;
  closed = 0;
  private readonly options: NativeTuiControlServerOptions;
  constructor(options: NativeTuiControlServerOptions) {
    this.options = options;
    this.socketPath = options.socketPath ?? "/tmp/native-tui.sock";
  }
  async start(): Promise<void> {}
  async close(): Promise<void> {
    this.closed += 1;
  }
  async connect(onAccepted?: () => void): Promise<void> {
    await this.options.onBeforeConnect?.();
    onAccepted?.();
    this.connected = true;
    await this.options.onConnect?.();
  }
  async disconnect(): Promise<void> {
    this.connected = false;
    await this.options.onDisconnect?.();
  }
}

class PtyFixture implements NativeTuiPtyHostLike {
  state = "idle";
  pid = 91;
  started = 0;
  attached = 0;
  detached = 0;
  closed = 0;
  writes: string[] = [];
  resizes: Array<[number, number]> = [];
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  private readonly options: NativeTuiPtyHostOptions;
  constructor(options: NativeTuiPtyHostOptions) {
    this.options = options;
    this.columns = options.cols;
    this.rows = options.rows;
  }
  async start(): Promise<void> {
    this.started += 1;
    this.state = "running";
  }
  attachInput(): void {
    this.attached += 1;
    this.options.stdin?.on("data", (chunk) =>
      this.writes.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString(),
      ),
    );
  }
  detachInput(): void {
    this.detached += 1;
  }
  resize(columns: number, rows: number): void {
    this.resizes.push([columns, rows]);
  }
  async close(): Promise<void> {
    this.closed += 1;
    this.state = "closed";
  }
  emitOutput(data: Uint8Array): void {
    this.options.onOutput?.(data);
  }
  emitExit(event: NativeTuiPtyExit): void {
    this.options.onExit?.(event);
  }
}

type Fixture = {
  input: InputFixture;
  output: OutputFixture;
  control?: ControlFixture;
  pty?: PtyFixture;
};

function options(
  fixture: Fixture,
  overrides: Partial<ConstructorParameters<typeof NativeTuiSession>[0]> = {},
): ConstructorParameters<typeof NativeTuiSession>[0] {
  return {
    executablePath: "/tmp/mindcode-tui",
    pathExists: () => true,
    sessionId: "test-session",
    socketPath: "/tmp/mindcode-native-tui-test.sock",
    stdin: fixture.input,
    stdout: fixture.output,
    createControlServer: (serverOptions) => {
      fixture.control = new ControlFixture(serverOptions);
      return fixture.control;
    },
    createPtyHost: (ptyOptions) => {
      fixture.pty = new PtyFixture(ptyOptions);
      return fixture.pty;
    },
    ...overrides,
  };
}

async function connectAfterStart(
  fixture: Fixture,
  onAccepted?: () => void,
): Promise<void> {
  await Bun.sleep(0);
  await fixture.control?.connect(onAccepted);
}

describe("native TUI foreground session", () => {
  test("waits for handshake before consuming stdin and forwards output/input/resize", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(options(fixture));
    const launch = session.launch();
    expect(fixture.input.listeners.size).toBe(0);
    await connectAfterStart(fixture, () =>
      fixture.pty?.emitOutput(Buffer.from("handshake-screen")),
    );
    expect((await launch).source).toBe("native-tui");
    expect(fixture.input.listeners.size).toBe(1);

    fixture.input.emit(Buffer.from("hello"));
    fixture.pty?.emitOutput(Buffer.from("screen"));
    session.resize(88, 24);
    expect(fixture.pty?.writes).toEqual(["hello"]);
    expect(
      fixture.output.chunks.map((chunk) => Buffer.from(chunk).toString()),
    ).toEqual(["handshake-screen", "screen"]);
    expect(fixture.pty?.resizes).toEqual([[88, 24]]);
    expect(fixture.input.isRaw).toBe(true);
    await session.close();
    expect(fixture.input.isRaw).toBe(false);
  });

  test("uses the current host dimensions and propagates host resize to PTY and bridge", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    fixture.output.columns = 173;
    fixture.output.rows = 51;
    const sizes: Array<[number, number]> = [];
    const session = new NativeTuiSession(
      options(fixture, {
        onTerminalSize: ({ columns, rows }) => sizes.push([columns, rows]),
      }),
    );
    const launch = session.launch();
    await connectAfterStart(fixture);
    await launch;

    expect([fixture.pty?.columns, fixture.pty?.rows]).toEqual([173, 51]);
    expect(fixture.pty?.resizes).toEqual([]);
    fixture.output.resize(91, 29);
    expect(fixture.pty?.resizes).toEqual([[91, 29]]);
    expect(sizes).toEqual([[91, 29]]);
    await session.close();
    expect(fixture.output.listeners.size).toBe(0);
  });

  test("returns missing-binary fallback without installing stdin listeners", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(
      options(fixture, { pathExists: () => false }),
    );
    const result = await session.launch();
    expect(result).toMatchObject({
      source: "fallback",
      reason: "missing_binary",
    });
    expect(fixture.input.listeners.size).toBe(0);
    expect(fixture.control).toBeUndefined();
  });

  test("cleans up the PTY and socket on PTY failure", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(
      options(fixture, {
        createPtyHost: () => {
          throw new Error("pty unavailable");
        },
      }),
    );
    const result = await session.launch();
    expect(result).toMatchObject({ source: "fallback", reason: "pty_failure" });
    expect(fixture.control?.closed).toBe(1);
  });

  test("maps a strict handshake timeout and removes all resources", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(
      options(fixture, { handshakeTimeoutMs: 5 }),
    );
    const result = await session.launch();
    expect(result).toMatchObject({
      source: "fallback",
      reason: "handshake_timeout",
    });
    expect(fixture.pty?.closed).toBe(1);
    expect(fixture.control?.closed).toBe(1);
    expect(fixture.input.listeners.size).toBe(0);
  });

  test("kills and detaches exactly once when the ready child exits", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(options(fixture));
    const launch = session.launch();
    await connectAfterStart(fixture);
    await launch;
    fixture.pty?.emitExit({ exitCode: 0 });
    await Bun.sleep(0);
    expect(session.state).toBe("exited");
    expect(fixture.pty?.detached).toBe(1);
    expect(fixture.pty?.closed).toBe(1);
    expect(fixture.control?.closed).toBe(1);
  });

  test("maps a child exit before handshake", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const session = new NativeTuiSession(
      options(fixture, {
        createPtyHost: (ptyOptions) => {
          fixture.pty = new PtyFixture(ptyOptions);
          const originalStart = fixture.pty.start.bind(fixture.pty);
          fixture.pty.start = async () => {
            await originalStart();
            fixture.pty?.emitExit({ exitCode: 7 });
          };
          return fixture.pty;
        },
      }),
    );
    const result = await session.launch();
    expect(result).toMatchObject({
      source: "fallback",
      reason: "exited_before_ready",
    });
    expect(fixture.control?.closed).toBe(1);
  });

  test("does not create a late PTY after close begins during server startup", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    let releaseServer!: () => void;
    const serverStarted = new Promise<void>((resolve) => {
      releaseServer = resolve;
    });
    let ptyCreations = 0;
    const session = new NativeTuiSession(
      options(fixture, {
        createControlServer: (serverOptions) => {
          fixture.control = new ControlFixture(serverOptions);
          fixture.control.start = () => serverStarted;
          return fixture.control;
        },
        createPtyHost: (ptyOptions) => {
          ptyCreations += 1;
          fixture.pty = new PtyFixture(ptyOptions);
          return fixture.pty;
        },
      }),
    );
    const launch = session.launch();
    await Bun.sleep(0);
    const closing = session.close();
    releaseServer();
    await closing;
    await expect(launch).resolves.toMatchObject({ source: "fallback" });
    expect(ptyCreations).toBe(0);
    expect(fixture.control?.closed).toBe(1);
    expect(session.state).toBe("closed");
  });

  test("propagates disconnect and reconnect attempts to the connection observer", async () => {
    const fixture: Fixture = {
      input: new InputFixture(),
      output: new OutputFixture(),
    };
    const events: Array<{ state: string; reconnect_attempts: number }> = [];
    const session = new NativeTuiSession(
      options(fixture, {
        onConnectionStateChange: ({ state, reconnect_attempts }) => {
          events.push({ state, reconnect_attempts });
        },
      }),
    );
    const launch = session.launch();
    await connectAfterStart(fixture);
    await launch;
    await fixture.control?.disconnect();
    await fixture.control?.connect();

    expect(events).toEqual(
      expect.arrayContaining([
        { state: "connecting", reconnect_attempts: 0 },
        { state: "connected", reconnect_attempts: 0 },
        { state: "disconnected", reconnect_attempts: 0 },
        { state: "reconnecting", reconnect_attempts: 1 },
        { state: "connected", reconnect_attempts: 1 },
      ]),
    );
    await session.close();
  });
});
