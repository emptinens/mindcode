import type * as React from "react";
import { useEffect, useRef, useState } from "react";
import { Box } from "../../ink.js";
import { getInitialSettings } from "../../utils/settings/settings.js";
import { Sakura } from "./Sakura.js";
import type { SakuraPose } from "./sakuraArt.js";

type Props = {
  compact?: boolean;
  interactive?: boolean;
};

const FRAME_MS = 90;
const IDLE_FRAME = -1;
const SEQUENCE: readonly SakuraPose[] = [
  "default",
  "look-right",
  "bloom",
  "look-left",
  "default",
];

/**
 * Low-cost click animation for interactive full-screen layouts.
 * Compact, noninteractive, and reduced-motion contexts render one static frame
 * and allocate no timer.
 */
export function AnimatedSakura({
  compact = false,
  interactive = true,
}: Props): React.ReactNode {
  const [reducedMotion] = useState(
    () => getInitialSettings().prefersReducedMotion ?? false,
  );
  const enabled = !compact && interactive && !reducedMotion;
  const [frame, setFrame] = useState(IDLE_FRAME);
  const frameRef = useRef(IDLE_FRAME);

  useEffect(() => {
    if (frame === IDLE_FRAME) return;
    if (!enabled || frame >= SEQUENCE.length) {
      frameRef.current = IDLE_FRAME;
      setFrame(IDLE_FRAME);
      return;
    }
    const timer = setTimeout(() => {
      frameRef.current = frame + 1;
      setFrame(frame + 1);
    }, FRAME_MS);
    return () => clearTimeout(timer);
  }, [enabled, frame]);

  const onClick = enabled
    ? () => {
        if (frameRef.current === IDLE_FRAME) {
          frameRef.current = 0;
          setFrame(0);
        }
      }
    : undefined;

  return (
    <Box
      height={3}
      width={9}
      flexDirection="column"
      flexShrink={0}
      onClick={onClick}
    >
      <Sakura pose={frame >= 0 ? SEQUENCE[frame] : "default"} />
    </Box>
  );
}
