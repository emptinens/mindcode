import type React from "react";
import { useCallback } from "react";
import { Box, Text } from "../ink.js";
import { useKeybinding } from "../keybindings/useKeybinding.js";

type Props = {
  onDone(): void;
  startingMessage?: string;
  mode?: "login" | "setup-token";
};

export function VexzyApiKeySetup({
  onDone,
  startingMessage,
}: Props): React.ReactNode {
  const apiKeyConfigured = Boolean(process.env.VEXZY_API_KEY?.trim());
  const handleContinue = useCallback(() => {
    onDone();
  }, [onDone]);

  useKeybinding("confirm:yes", handleContinue, {
    context: "Confirmation",
    isActive: true,
  });

  return (
    <Box flexDirection="column" gap={1} paddingLeft={1}>
      <Text bold>
        {startingMessage ?? "MindCode uses VEXZY_API_KEY for API access."}
      </Text>
      {apiKeyConfigured ? (
        <Text color="success">VEXZY_API_KEY is configured.</Text>
      ) : (
        <Box flexDirection="column" gap={1}>
          <Text color="warning">VEXZY_API_KEY is not configured.</Text>
          <Text>Set your VEXZY API key in the shell before continuing:</Text>
          <Text>export VEXZY_API_KEY=&quot;forge-...&quot;</Text>
          <Text dimColor>Restart MindCode after setting the variable.</Text>
        </Box>
      )}
      <Text dimColor>
        Press <Text bold>Enter</Text> to continue.
      </Text>
    </Box>
  );
}
