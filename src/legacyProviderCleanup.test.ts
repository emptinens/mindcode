import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const sourceChecks: Record<string, string[]> = {
  "src/services/mcp/normalization.ts": ["CLAUDEAI_SERVER_PREFIX", "claude.ai"],
  "src/constants/product.ts": [
    "CLAUDE_AI_BASE_URL",
    "CLAUDE_AI_STAGING_BASE_URL",
    "getClaudeAiBaseUrl",
    "getRemoteSessionUrl",
  ],
  "src/utils/toolSearch.ts": [
    "ANTHROPIC_BASE_URL",
    "isFirstPartyAnthropicBaseUrl",
  ],
  "src/utils/cleanup.ts": [
    "cleanupNpmCacheForAnthropicPackages",
    "@anthropic-ai/claude-",
  ],
  "src/utils/settings/constants.ts": ["claude-code-settings.json"],
  "src/utils/fastMode.ts": ["claude.com/product/claude-code"],
  "src/tools/AgentTool/built-in/statuslineSetup.ts": [
    "Claude.ai subscription",
    ".rate_limits",
  ],
  "src/entrypoints/sdk/coreSchemas.ts": [
    "Rate limit information for claude.ai subscription users",
  ],
  "src/services/mcp/channelNotification.ts": ["claude.ai"],
  "src/voice/voiceModeEnabled.ts": ["claude.ai"],
  "src/utils/plugins/fetchTelemetry.ts": ["storage.googleapis.com"],
  "src/utils/settings/types.ts": ["claude.ai"],
  "src/tools/ConfigTool/ConfigTool.ts": ["Claude.ai"],
  "src/utils/plugins/validatePlugin.ts": ["Claude.ai"],
  "src/hooks/useVoice.ts": ["Claude.ai"],
};

const bundleResidues = [
  "CLAUDEAI_SERVER_PREFIX",
  "https://claude-ai.staging.ant.dev",
  "getClaudeAiBaseUrl",
  "ANTHROPIC_BASE_URL=",
  "@anthropic-ai/claude-",
  "claude-code-settings.json",
  "https://claude.com/product/claude-code",
  "Claude.ai subscription usage limits",
  "Rate limit information for claude.ai subscription users",
  "https://claude.ai/api/desktop",
  "https://claude.ai/download",
  "claude.ai",
  "Claude.ai",
  "storage.googleapis.com",
];

function source(path: string): string {
  const [withoutSourceMap] = readFileSync(resolve(root, path), "utf8").split(
    "\n//# sourceMappingURL=",
    1,
  );
  return withoutSourceMap ?? "";
}

describe("bundle-visible legacy provider cleanup", () => {
  test("targeted runtime sources contain no removed provider paths", () => {
    for (const [path, residues] of Object.entries(sourceChecks)) {
      const text = source(path);
      for (const residue of residues) {
        expect(text.indexOf(residue), `${path} contains ${residue}`).toBe(-1);
      }
    }
  });

  test("MCP normalization remains generic for local server names", async () => {
    const { normalizeNameForMCP } = await import(
      "./services/mcp/normalization.js"
    );
    expect(normalizeNameForMCP("local.server name")).toBe("local_server_name");
    expect(normalizeNameForMCP("a..b")).toBe("a__b");
  });

  test("production bundle contains no targeted legacy residues", () => {
    const bundlePath = resolve(root, "dist/mindcode.js");
    if (!existsSync(bundlePath)) return;
    const bundle = readFileSync(bundlePath, "utf8");
    for (const residue of bundleResidues) {
      expect(
        bundle.indexOf(residue),
        `dist/mindcode.js contains ${residue}`,
      ).toBe(-1);
    }
  });
});
