import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

const sourceChecks: Record<string, string[]> = {
  "scripts/build-bundle.mjs": [
    "@anthropic-ai/",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "PACKAGE_URL",
    "NATIVE_PACKAGE_URL",
  ],
  "scripts/bun-plugin-shims.ts": ["@anthropic-ai/", "@ant/"],
  "src/services/api/errorUtils.ts": [
    "Anthropic",
    "anthropic.com",
    "api.openai.com",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ],
  "src/utils/betas.ts": [
    "ANTHROPIC_BETAS",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
  ],
  "src/cli/update.ts": [
    "@anthropic",
    "ANTHROPIC_",
    "OPENAI_",
    "api.anthropic.com",
    "api.openai.com",
    "getLatestVersion",
    "installGlobalPackage",
    "installOrUpdateMindCodePackage",
    "installLatestNative",
    "removeInstalledSymlink",
    "localInstallationExists",
  ],
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
  "src/tools/PowerShellTool/pathValidation.ts": [
    "ANTHROPIC_API_KEY",
    "api.anthropic.com",
  ],
  "src/tools/PowerShellTool/powershellPermissions.ts": [
    "ANTHROPIC_API_KEY",
    "api.anthropic.com",
  ],
  "src/types/command.ts": [
    "ANTHROPIC_",
    "api.anthropic.com",
    "claude-ai",
    "console",
  ],
  "src/utils/proxy.ts": ["ANTHROPIC_", "api.anthropic.com", "forAnthropicAPI"],
  "src/utils/nativeInstaller/packageManagers.ts": [
    "@anthropic-ai",
    "Claude CLI",
  ],
  "src/commands.ts": [
    "install-github-app",
    "anthropic",
    "claude-ai",
    "console",
  ],
};

const bundleResidues = [
  "@anthropic-ai/",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "api.anthropic.com",
  "api.openai.com",
  "https://api.anthropic.com",
  "https://api.openai.com",
  "npm view @anthropic",
  "installGlobalPackage",
  "installOrUpdateMindCodePackage",
  "installLatestNative",
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

  test("provider-specific GitHub installer is fully removed", () => {
    expect(existsSync(resolve(root, "commands/install-github-app"))).toBe(
      false,
    );
    expect(existsSync(resolve(root, "constants/github-app.ts"))).toBe(false);
    expect(
      existsSync(resolve(root, "components/WorkflowMultiselectDialog.tsx")),
    ).toBe(false);
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
    expect(bundle).toContain("VEXZY_API_KEY");
    expect(bundle).toContain("api.echogate.one");
  });
});
