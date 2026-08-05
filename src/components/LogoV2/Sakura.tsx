import type * as React from "react";
import { Box, Text } from "../../ink.js";
import {
  SAKURA_ART,
  SAKURA_HEIGHT,
  SAKURA_WIDTH,
  type SakuraPose,
} from "./sakuraArt.js";

export { SAKURA_ART, SAKURA_HEIGHT, SAKURA_WIDTH } from "./sakuraArt.js";
export type { SakuraPose } from "./sakuraArt.js";

const PETAL_COLOR = "rgb(255,153,204)";
const PETAL_HIGHLIGHT = "rgb(255,190,224)";
const TRUNK_COLOR = "rgb(177,105,79)";

type Props = {
  pose?: SakuraPose;
};

/** MindCode's compact Sakura tree mascot. */
export function Sakura({ pose = "default" }: Props): React.ReactNode {
  const frame = SAKURA_ART[pose];
  return (
    <Box
      width={SAKURA_WIDTH}
      height={SAKURA_HEIGHT}
      flexDirection="column"
      flexShrink={0}
    >
      {frame.map((row, index) => (
        <Text
          key={row}
          color={
            index === 0
              ? PETAL_HIGHLIGHT
              : index < 4
                ? PETAL_COLOR
                : TRUNK_COLOR
          }
        >
          {row}
        </Text>
      ))}
    </Box>
  );
}
