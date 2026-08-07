import type React from "react";
import type { StatsStore } from "./context/stats.js";
import type { Root } from "./ink.js";
import type { Props as REPLProps } from "./screens/REPL.js";
import type { AppState } from "./state/AppStateStore.js";
import type { FpsMetrics } from "./utils/fpsTracker.js";
import { getBaseRenderOptions } from "./utils/renderOptions.js";

type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};

type RenderAndRun = (
  root: Root,
  element: React.ReactNode,
  beforeShutdown?: () => void | Promise<void>,
) => Promise<void>;

export async function launchRepl(
  root: Root,
  appProps: AppWrapperProps,
  replProps: REPLProps,
  renderAndRun: RenderAndRun,
): Promise<void> {
  const { App } = await import("./components/App.js");
  const { REPL } = await import("./screens/REPL.js");
  const gate = (
    await import("./runtime/nativeTui/featureGate.js")
  ).resolveNativeTuiFeatureGate();
  if (!gate.enabled) {
    await renderAndRun(
      root,
      <App {...appProps}>
        <REPL {...replProps} />
      </App>,
    );
    return;
  }

  const [
    { NativeTuiControlServer },
    { NativeTuiInkBridge },
    { NativeTuiInkStatePublisher },
    { NativeTuiLaunchCoordinator },
  ] = await Promise.all([
    import("./runtime/nativeTui/controlServer.js"),
    import("./runtime/nativeTui/inkBridge.js"),
    import("./runtime/nativeTui/InkStatePublisher.js"),
    import("./runtime/nativeTui/launcher.js"),
  ]);
  let bridge: InstanceType<typeof NativeTuiInkBridge> | undefined;
  let inkUnmounted = false;
  const native = {
    exited: false,
    root: undefined as Root | undefined,
    rootUnmounted: false,
  };
  const unmountNativeRoot = (): void => {
    if (!native.root || native.rootUnmounted) return;
    native.rootUnmounted = true;
    native.root.unmount();
  };
  const coordinator = new NativeTuiLaunchCoordinator({
    gate,
    sessionOptions: {
      createControlServer: (options) => {
        const control = new NativeTuiControlServer(options);
        bridge = new NativeTuiInkBridge(control);
        bridge.setConnectionState({
          state: "connecting",
          reconnect_attempts: 0,
        });
        bridge.publishState(appProps.initialState);
        return control;
      },
      onBeforeConnect: async () => {
        if (inkUnmounted) return;
        inkUnmounted = true;
        root.unmount();
        const activeBridge = bridge;
        if (!activeBridge) throw new Error("Native TUI bridge is unavailable");
        const { createRoot } = await import("./ink.js");
        native.root = await createRoot(activeBridge.renderOptions);
        native.rootUnmounted = false;
      },
      onInput: (message) => bridge?.handleInput(message),
      onTerminalSize: (message) =>
        bridge?.resize(message.columns, message.rows),
      onConnectionStateChange: (event) => bridge?.setConnectionState(event),
      onExit: () => {
        native.exited = true;
        unmountNativeRoot();
      },
    },
  });
  const renderFallback = async (): Promise<void> => {
    const fallbackRoot = inkUnmounted
      ? await (await import("./ink.js")).createRoot(getBaseRenderOptions(false))
      : root;
    await renderAndRun(
      fallbackRoot,
      <App {...appProps}>
        <REPL {...replProps} />
      </App>,
    );
  };

  const launch = await coordinator.launch();
  if (launch.source !== "native-tui" || !bridge || !native.root) {
    unmountNativeRoot();
    bridge?.close();
    await coordinator.close();
    await renderFallback();
    return;
  }

  const activeBridge = bridge;
  const activeRoot = native.root;
  if (native.exited) {
    unmountNativeRoot();
    activeBridge.close();
    await coordinator.close();
    await renderFallback();
    return;
  }

  await renderAndRun(
    activeRoot,
    <App {...appProps}>
      <REPL {...replProps} />
      <NativeTuiInkStatePublisher bridge={activeBridge} />
    </App>,
    async () => {
      native.rootUnmounted = true;
      activeBridge.close();
      await coordinator.close();
    },
  );
}
