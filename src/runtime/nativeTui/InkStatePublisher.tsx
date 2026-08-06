import type React from "react";
import { useEffect } from "react";
import { useAppState } from "../../state/AppState.js";
import type { AppState } from "../../state/AppStateStore.js";
import type { NativeTuiInkBridge } from "./inkBridge.js";

export function NativeTuiInkStatePublisher({
  bridge,
}: {
  bridge: NativeTuiInkBridge;
}): React.ReactNode {
  const tasks = useAppState((state: AppState) => state.tasks);
  const statusLineText = useAppState((state: AppState) => state.statusLineText);
  const mainLoopModel = useAppState((state: AppState) => state.mainLoopModel);
  const effortValue = useAppState((state: AppState) => state.effortValue);

  useEffect(() => {
    bridge.publishState({
      tasks,
      statusLineText,
      mainLoopModel,
      effortValue,
    });
  }, [bridge, effortValue, mainLoopModel, statusLineText, tasks]);

  return null;
}
