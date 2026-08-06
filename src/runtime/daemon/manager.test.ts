import { afterEach, describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
  DaemonClientLike,
  DaemonManagerClock,
  DaemonManagerOptions,
} from "./manager.js";
import { DaemonManager } from "./manager.js";
import type {
  DaemonClientOptions,
  DaemonSpawnOptions,
  DaemonSpawnResult,
} from "./types.js";

const managers: DaemonManager[] = [];

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.shutdownForTests();
});

class FakeClient implements DaemonClientLike {
  state: "disconnected" | "connecting" | "ready" | "closed" = "disconnected";
  connectCalls = 0;
  connectFailures = 0;
  requestCalls = 0;
  closeCalls = 0;

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.state = "connecting";
    if (this.connectFailures > 0) {
      this.connectFailures -= 1;
      this.state = "disconnected";
      throw new Error("socket unavailable");
    }
    this.state = "ready";
  }

  async request<T>(): Promise<T> {
    this.requestCalls += 1;
    return { daemon: true } as T;
  }

  disconnect(): void {
    this.state = "disconnected";
  }

  close(): void {
    this.closeCalls += 1;
    this.state = "closed";
  }
}

class FakeChild extends EventEmitter {
  killCalls = 0;

  unref(): this {
    return this;
  }

  kill(): boolean {
    this.killCalls += 1;
    this.emit("exit");
    return true;
  }
}

function testOptions(
  client: FakeClient,
  spawn: (options: DaemonSpawnOptions) => DaemonSpawnResult,
  clock: Partial<DaemonManagerClock> = {},
  overrides: Partial<DaemonManagerOptions> = {},
): DaemonManagerOptions {
  return {
    env: {},
    platform: "darwin",
    createClient: (_options: DaemonClientOptions) => client,
    spawn,
    clock: {
      now: clock.now ?? (() => 0),
      sleep: clock.sleep ?? (async () => undefined),
      random: clock.random ?? (() => 0.5),
    },
    readinessTimeoutMs: 100,
    maxReadinessAttempts: 4,
    ...overrides,
  };
}

describe("DaemonManager", () => {
  test("shares concurrent readiness and starts one sidecar", async () => {
    const client = new FakeClient();
    client.connectFailures = 1;
    let spawnCalls = 0;
    const child = new FakeChild();
    const manager = new DaemonManager(
      testOptions(client, () => {
        spawnCalls += 1;
        return {
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: child as unknown as ChildProcess,
        };
      }),
    );
    managers.push(manager);

    await Promise.all([
      manager.ensureReady(),
      manager.ensureReady(),
      manager.ensureReady(),
    ]);

    expect(spawnCalls).toBe(1);
    expect(client.connectCalls).toBe(2);
    expect(manager.status()).toMatchObject({
      state: "ready",
      startupAttempts: 1,
    });
  });

  test("falls back when the sidecar remains unavailable without spawn storms", async () => {
    const client = new FakeClient();
    client.connectFailures = 100;
    let spawnCalls = 0;
    const manager = new DaemonManager(
      testOptions(client, () => {
        spawnCalls += 1;
        return {
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: new FakeChild() as unknown as ChildProcess,
        };
      }),
    );
    managers.push(manager);

    const results = await Promise.all([
      manager.requestWithFallback("status", undefined, "fallback"),
      manager.requestWithFallback("status", undefined, "fallback"),
    ]);

    expect(results[0]).toMatchObject({ source: "fallback", value: "fallback" });
    expect(results[1]).toMatchObject({ source: "fallback", value: "fallback" });
    expect(spawnCalls).toBe(1);
    expect(manager.status().state).toBe("unavailable");
  });

  test("reconnects and starts a replacement after an idle exit", async () => {
    const client = new FakeClient();
    client.connectFailures = 1;
    let spawnCalls = 0;
    const children: FakeChild[] = [];
    const manager = new DaemonManager(
      testOptions(client, () => {
        spawnCalls += 1;
        const child = new FakeChild();
        children.push(child);
        return {
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: child as unknown as ChildProcess,
        };
      }),
    );
    managers.push(manager);

    await expect(
      manager.requestWithFallback("ping", undefined, "fallback"),
    ).resolves.toMatchObject({
      source: "daemon",
    });
    expect(children).toHaveLength(1);
    children[0]?.emit("exit");
    client.disconnect();
    client.connectFailures = 1;
    await expect(
      manager.requestWithFallback("ping", undefined, "fallback"),
    ).resolves.toMatchObject({
      source: "daemon",
    });

    expect(spawnCalls).toBe(2);
    expect(children).toHaveLength(2);
  });

  test("background warmup uses unref sleep while foreground retries use ref sleep", async () => {
    const client = new FakeClient();
    client.connectFailures = 1;
    const sleepModes: boolean[] = [];
    const manager = new DaemonManager(
      testOptions(
        client,
        () => ({
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: new FakeChild() as unknown as ChildProcess,
        }),
        {
          sleep: async (_milliseconds, ref) => {
            sleepModes.push(ref);
          },
        },
      ),
    );
    managers.push(manager);

    manager.kickStartup();
    await Bun.sleep(10);
    expect(sleepModes).toEqual([false]);

    const second = new FakeClient();
    second.connectFailures = 1;
    const foregroundModes: boolean[] = [];
    const foreground = new DaemonManager(
      testOptions(
        second,
        () => ({
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: new FakeChild() as unknown as ChildProcess,
        }),
        {
          sleep: async (_milliseconds, ref) => {
            foregroundModes.push(ref);
          },
        },
      ),
    );
    managers.push(foreground);
    await foreground.ensureReady();
    expect(foregroundModes).toEqual([true]);
  });

  test("foreground caller upgrades a background single-flight and cleanup closes only its client", async () => {
    const client = new FakeClient();
    client.connectFailures = 1;
    let releaseSleep!: () => void;
    const sleep = new Promise<void>((resolve) => {
      releaseSleep = resolve;
    });
    const child = new FakeChild();
    const manager = new DaemonManager(
      testOptions(
        client,
        () => ({
          executablePath: "/tmp/mindcoded",
          socketPath: "/tmp/mindcoded.sock",
          process: child as unknown as ChildProcess,
        }),
        { sleep: async () => sleep },
      ),
    );
    managers.push(manager);

    manager.kickStartup();
    await Bun.sleep(10);
    const foreground = manager.ensureReady();
    await Bun.sleep(10);
    await manager.cleanup();
    expect(client.closeCalls).toBe(1);
    expect(child.killCalls).toBe(0);
    releaseSleep();
    await foreground;
    expect(manager.status().spawned).toBe(false);
  });

  test("does not touch the client or spawn on win32 or explicit disable", async () => {
    for (const options of [
      { platform: "win32" as const, env: {} },
      { platform: "darwin" as const, env: { MINDCODE_DAEMON_DISABLED: "1" } },
    ]) {
      const client = new FakeClient();
      let spawnCalls = 0;
      const manager = new DaemonManager(
        testOptions(
          client,
          () => {
            spawnCalls += 1;
            return {
              executablePath: "/tmp/mindcoded",
              socketPath: "/tmp/mindcoded.sock",
              process: new FakeChild() as unknown as ChildProcess,
            };
          },
          {},
          options,
        ),
      );
      managers.push(manager);

      await expect(
        manager.requestWithFallback("status", undefined, "fallback"),
      ).resolves.toMatchObject({
        source: "fallback",
        value: "fallback",
        reason: "disabled",
      });
      expect(client.connectCalls).toBe(0);
      expect(spawnCalls).toBe(0);
      expect(manager.status().state).toBe("disabled");
    }
  });
});
