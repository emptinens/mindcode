import { useEffect, useState } from "react";
import {
  type VexzyLimits,
  currentLimits,
  statusListeners,
} from "./vexzyLimits.js";

export function useVexzyLimits(): VexzyLimits {
  const [limits, setLimits] = useState<VexzyLimits>({ ...currentLimits });

  useEffect(() => {
    const listener = (newLimits: VexzyLimits) => {
      setLimits({ ...newLimits });
    };
    statusListeners.add(listener);

    return () => {
      statusListeners.delete(listener);
    };
  }, []);

  return limits;
}
