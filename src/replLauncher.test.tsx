import { beforeEach, describe, expect, mock, test } from "bun:test";
import type React from "react";
import type { Root } from "./ink.js";
import type { AppState } from "./state/AppStateStore.js";

const modulePath = (relativePath: string): string =>
  new URL(relativePath, import.meta.url).pathname;

type SessionOptions = {
  createControlServer?: (options: Record<string, never>) => unknown;
  onBeforeConnect?: () => void | Promise<void>;
  onExit?: () => void;
};

type CoordinatorOptions = {
  sessionOptions?: SessionOptions;
};

type LaunchMode = "native" | "fallback-after-connect" | "exit-before-render";

let launchMode: LaunchMode = "native";
const coordinators: FakeCoordinator[] = [];
const bridges: FakeBridge[] = [];
const createdRoots: TestRoot[] = [];

class FakeControlServer {}

class FakeBridge {
  readonly renderOptions = {};
  closeCount = 0;

  constructor(_control: FakeControlServer) {
    bridges.push(this);
  }

  publishState(_state: AppState): void {}
  handleInput(_message: unknown): void {}
  resize(_columns: number, _rows: number): void {}

  close(): void {
    this.closeCount += 1;
  }
}

class FakeCoordinator {
  closeCount = 0;

  constructor(private readonly options: CoordinatorOptions) {
    coordinators.push(this);
  }

  async launch(): Promise<
    { source: "native-tui"; session: object } | { source: "fallback" }
  > {
    this.options.sessionOptions?.createControlServer?.({});
    await this.options.sessionOptions?.onBeforeConnect?.();
    if (launchMode === "fallback-after-connect") return { source: "fallback" };
    if (launchMode === "exit-before-render") {
      this.options.sessionOptions?.onExit?.();
    }
    return { source: "native-tui", session: {} };
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

type TestRoot = Root & {
  renders: React.ReactNode[];
  unmountCount: number;
};

function createTestRoot(): TestRoot {
  const root: TestRoot = {
    renders: [],
    unmountCount: 0,
    render(node) {
      root.renders.push(node);
    },
    unmount() {
      root.unmountCount += 1;
    },
    async waitUntilExit() {},
  };
  return root;
}

mock.module(modulePath("./components/App.tsx"), () => ({
  App: ({ children }: { children?: React.ReactNode }) => children ?? null,
}));
mock.module(modulePath("./screens/REPL.tsx"), () => ({ REPL: () => null }));
mock.module(modulePath("./runtime/nativeTui/featureGate.ts"), () => ({
  resolveNativeTuiFeatureGate: () => ({ enabled: true }),
}));
mock.module(modulePath("./runtime/nativeTui/controlServer.ts"), () => ({
  NativeTuiControlServer: FakeControlServer,
}));
mock.module(modulePath("./runtime/nativeTui/inkBridge.ts"), () => ({
  NativeTuiInkBridge: FakeBridge,
}));
mock.module(modulePath("./runtime/nativeTui/InkStatePublisher.tsx"), () => ({
  NativeTuiInkStatePublisher: () => null,
}));
mock.module(modulePath("./runtime/nativeTui/launcher.ts"), () => ({
  NativeTuiLaunchCoordinator: FakeCoordinator,
}));
mock.module(modulePath("./ink.ts"), () => ({
  createRoot: async () => {
    const root = createTestRoot();
    createdRoots.push(root);
    return root;
  },
}));

const { launchRepl } = await import("./replLauncher.js");

beforeEach(() => {
  launchMode = "native";
  coordinators.length = 0;
  bridges.length = 0;
  createdRoots.length = 0;
});

const appProps = {
  getFpsMetrics: () => undefined,
  initialState: {} as AppState,
};
const replProps = {} as Parameters<typeof launchRepl>[2];

async function renderAndClose(
  root: Root,
  element: React.ReactNode,
  beforeShutdown?: () => void | Promise<void>,
): Promise<void> {
  root.render(element);
  await beforeShutdown?.();
}

describe("REPL native TUI integration", () => {
  test("hands terminal ownership to native TUI and closes it with the hidden Ink root", async () => {
    const originalRoot = createTestRoot();

    await launchRepl(originalRoot, appProps, replProps, renderAndClose);

    expect(originalRoot.unmountCount).toBe(1);
    expect(createdRoots).toHaveLength(1);
    expect(createdRoots[0]?.renders).toHaveLength(1);
    expect(bridges[0]?.closeCount).toBe(1);
    expect(coordinators[0]?.closeCount).toBe(1);
  });

  test("recreates Ink fallback when native startup fails after terminal takeover", async () => {
    launchMode = "fallback-after-connect";
    const originalRoot = createTestRoot();

    await launchRepl(originalRoot, appProps, replProps, renderAndClose);

    expect(originalRoot.unmountCount).toBe(1);
    expect(createdRoots).toHaveLength(2);
    expect(createdRoots[0]?.unmountCount).toBe(1);
    expect(createdRoots[1]?.renders).toHaveLength(1);
    expect(bridges[0]?.closeCount).toBe(1);
    expect(coordinators[0]?.closeCount).toBe(1);
  });

  test("falls back when the native process exits before the hidden renderer is ready", async () => {
    launchMode = "exit-before-render";
    const originalRoot = createTestRoot();

    await launchRepl(originalRoot, appProps, replProps, renderAndClose);

    expect(originalRoot.unmountCount).toBe(1);
    expect(createdRoots).toHaveLength(2);
    expect(createdRoots[0]?.unmountCount).toBe(1);
    expect(createdRoots[1]?.renders).toHaveLength(1);
    expect(bridges[0]?.closeCount).toBe(1);
    expect(coordinators[0]?.closeCount).toBe(1);
  });
});
