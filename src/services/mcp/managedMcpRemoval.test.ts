import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";

const source = (relativePath: string): string =>
  readFileSync(new URL(`./${relativePath}`, import.meta.url), "utf8");

const discoveryExport = ["fetchClaudeAI", "McpConfigsIfEligible"].join("");
const connectionStateReader = ["hasClaudeAiMcp", "EverConnected"].join("");
const claudeDedupHelper = ["dedupClaudeAi", "McpServers"].join("");
const claudePromise = ["claudeai", "Promise"].join("");
const claudeConfigs = ["claudeai", "Configs"].join("");
const claudeNotificationKey = ["mcp-", "claudeai-"];
const removedProxyTransport = ["claudeai", "proxy"].join("-");

function collectSourceFiles(directory: URL): URL[] {
  const files: URL[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(child));
    } else if (/\.(?:[cm]?js|tsx?)$/.test(entry.name)) {
      files.push(child);
    }
  }
  return files;
}

describe("local MCP source loading", () => {
  test("does not retain Claude.ai-managed discovery or state consumers", () => {
    const config = source("config.ts");
    const connections = source("useManageMCPConnections.ts");
    const notifications = readFileSync(
      new URL(
        "../../hooks/notifs/useMcpConnectivityStatus.tsx",
        import.meta.url,
      ),
      "utf8",
    );
    expect(config).not.toContain(discoveryExport);
    expect(connections).not.toContain(discoveryExport);
    expect(notifications).not.toContain(connectionStateReader);
    expect(config).not.toContain(claudeDedupHelper);
    expect(connections).not.toContain(claudePromise);
    expect(connections).not.toContain(claudeConfigs);
    expect(notifications).not.toContain(claudeNotificationKey.join(""));
    expect(existsSync(new URL("./claudeai.ts", import.meta.url))).toBe(false);
  });

  test("removes the managed proxy transport from all source consumers", () => {
    const consumers = collectSourceFiles(new URL("../../", import.meta.url))
      .filter(file => readFileSync(file, "utf8").includes(removedProxyTransport))
      .map(file => file.pathname);

    expect(consumers).toEqual([]);
  });

  test("keeps local MCP transports and manual OAuth", () => {
    const types = source("types.ts");
    const oauth = source("auth.ts");
    const authTool = readFileSync(
      new URL("../../tools/McpAuthTool/McpAuthTool.ts", import.meta.url),
      "utf8",
    );
    const pluginIntegration = readFileSync(
      new URL("../../utils/plugins/mcpPluginIntegration.ts", import.meta.url),
      "utf8",
    );

    for (const transport of ["stdio", "sse", "http"]) {
      expect(types).toContain(`'${transport}'`);
      expect(pluginIntegration).toContain(`case '${transport}'`);
    }
    expect(authTool).toContain("performMCPOAuthFlow");
    expect(oauth).not.toContain("constants/oauth");
    expect(oauth).not.toContain("claude.ai/oauth");
    expect(oauth).not.toContain("api.anthropic.com");
  });
});
