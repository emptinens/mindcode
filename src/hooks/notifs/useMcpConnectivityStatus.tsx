import { useEffect } from "react";
import { useNotifications } from "src/context/notifications.js";
import { getIsRemoteMode } from "../../bootstrap/state.js";
import { Text } from "../../ink.js";
import type { MCPServerConnection } from "../../services/mcp/types.js";

type Props = {
  mcpClients?: MCPServerConnection[];
};

const EMPTY_MCP_CLIENTS: MCPServerConnection[] = [];

export function useMcpConnectivityStatus({
  mcpClients = EMPTY_MCP_CLIENTS,
}: Props): void {
  const { addNotification } = useNotifications();

  useEffect(() => {
    if (getIsRemoteMode()) return;

    const failedClients = mcpClients.filter(
      (client) =>
        client.type === "failed" &&
        client.config.type !== "sse-ide" &&
        client.config.type !== "ws-ide",
    );
    const needsAuthServers = mcpClients.filter(
      (client) => client.type === "needs-auth",
    );

    if (failedClients.length > 0) {
      addNotification({
        key: "mcp-failed",
        jsx: (
          <>
            <Text color="error">
              {failedClients.length} MCP{" "}
              {failedClients.length === 1 ? "server" : "servers"} failed
            </Text>
            <Text dimColor> · /mcp</Text>
          </>
        ),
        priority: "medium",
      });
    }

    if (needsAuthServers.length > 0) {
      addNotification({
        key: "mcp-needs-auth",
        jsx: (
          <>
            <Text color="warning">
              {needsAuthServers.length} MCP{" "}
              {needsAuthServers.length === 1 ? "server needs" : "servers need"}{" "}
              auth
            </Text>
            <Text dimColor> · /mcp</Text>
          </>
        ),
        priority: "medium",
      });
    }
  }, [addNotification, mcpClients]);
}
