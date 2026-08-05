import type * as React from "react";
import { Box, Text } from "../../ink.js";
import { Sakura } from "./Sakura.js";

const WELCOME_WIDTH = 58;

/** Stable-width onboarding artwork using the MindCode Sakura mascot. */
export function WelcomeV2(): React.ReactNode {
  return (
    <Box width={WELCOME_WIDTH} flexDirection="column" alignItems="center">
      <Text>
        <Text color="rgb(255,153,204)">Welcome to MindCode</Text>{" "}
        <Text dimColor>v{MACRO.VERSION}</Text>
      </Text>
      <Box marginY={1}>
        <Sakura pose="bloom" />
      </Box>
    </Box>
  );
}
