import { afterEach, describe, expect, test } from "bun:test";
import { VexzyConfigurationError } from "../services/api/vexzy/errors.js";
import {
  checkAndRefreshOAuthTokenIfNeeded,
  getAccountInformation,
  getAnthropicApiKey,
  getAnthropicApiKeyWithSource,
  getApiKeyFromConfigOrMacOSKeychain,
  getAuthTokenSource,
  getClaudeAIOAuthTokens,
  getClaudeAIOAuthTokensAsync,
  getOauthAccountInfo,
  getSubscriptionType,
  isAnthropicAuthEnabled,
  isClaudeAISubscriber,
  isUsing3PServices,
  removeApiKey,
  saveApiKey,
} from "./auth.js";

const legacyApiKeyEnv = ["ANTHROPIC", "API_KEY"].join("_");
const legacyTokenEnv = ["MINDCODE", "OAUTH", "TOKEN"].join("_");
const mcpOauthEnv = "MINDCODE_MCP_OAUTH_TOKEN";
const envKeys = ["VEXZY_API_KEY", legacyApiKeyEnv, legacyTokenEnv, mcpOauthEnv];
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
) as Record<string, string | undefined>;

function restoreEnvironment(): void {
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }
}

afterEach(restoreEnvironment);

describe("VEXZY-only auth compatibility facade", () => {
  test("uses only VEXZY_API_KEY and exposes the compatibility source", () => {
    process.env.VEXZY_API_KEY = "forge-auth-key";
    process.env[legacyApiKeyEnv] = "legacy-key";
    process.env[legacyTokenEnv] = "legacy-token";

    expect(getAnthropicApiKey()).toBe("forge-auth-key");
    expect(getAnthropicApiKeyWithSource()).toEqual({
      key: "forge-auth-key",
      source: "VEXZY_API_KEY",
    });
    expect(getApiKeyFromConfigOrMacOSKeychain()).toEqual({
      key: "forge-auth-key",
      source: "VEXZY_API_KEY",
    });
    expect(getAuthTokenSource()).toEqual({
      source: "VEXZY_API_KEY",
      hasToken: true,
    });
  });

  test("missing VEXZY_API_KEY never falls back to legacy environment values", () => {
    Reflect.deleteProperty(process.env, "VEXZY_API_KEY");
    process.env[legacyApiKeyEnv] = "legacy-key";
    process.env[legacyTokenEnv] = "legacy-token";

    expect(getAnthropicApiKey()).toBeNull();
    expect(getAnthropicApiKeyWithSource()).toEqual({
      key: null,
      source: "none",
    });
    expect(getApiKeyFromConfigOrMacOSKeychain()).toBeNull();
    expect(getAuthTokenSource()).toEqual({ source: "none", hasToken: false });
    expect(isAnthropicAuthEnabled()).toBe(false);
  });

  test.each(["", "legacy-key", "forge-", "forge-key with-space"])(
    "rejects invalid supplied VEXZY credentials: %j",
    (value) => {
      process.env.VEXZY_API_KEY = value;

      expect(() => getAnthropicApiKey()).toThrow(VexzyConfigurationError);
      expect(() => getAnthropicApiKeyWithSource()).toThrow(
        VexzyConfigurationError,
      );
      expect(() => getAuthTokenSource()).toThrow(VexzyConfigurationError);
      expect(() => saveApiKey(value)).toThrow(VexzyConfigurationError);
    },
  );

  test("legacy account, subscription, provider, and token operations are neutral", async () => {
    process.env.VEXZY_API_KEY = "forge-auth-key";

    expect(isAnthropicAuthEnabled()).toBe(false);
    expect(isClaudeAISubscriber()).toBe(false);
    expect(isUsing3PServices()).toBe(false);
    expect(getSubscriptionType()).toBeNull();
    expect(getOauthAccountInfo()).toBeUndefined();
    expect(getAccountInformation()).toBeUndefined();
    expect(getClaudeAIOAuthTokens()).toBeNull();
    await expect(getClaudeAIOAuthTokensAsync()).resolves.toBeNull();
    await expect(checkAndRefreshOAuthTokenIfNeeded()).resolves.toBe(false);
  });

  test("removeApiKey only removes the VEXZY runtime credential", async () => {
    process.env.VEXZY_API_KEY = "forge-auth-key";
    process.env[mcpOauthEnv] = "mcp-token";

    await removeApiKey();

    expect(getAnthropicApiKey()).toBeNull();
    expect(process.env[mcpOauthEnv]).toBe("mcp-token");
  });

  test("source has no legacy auth imports or runtime credential names", async () => {
    const source = await Bun.file(new URL("./auth.ts", import.meta.url)).text();

    expect(source).not.toMatch(/constants\/oauth|services\/oauth/);
    for (const forbidden of [
      "ANTHROPIC_API_KEY",
      "MINDCODE_OAUTH_TOKEN",
      "MINDCODE_USE_BEDROCK",
      "MINDCODE_USE_VERTEX",
      "MINDCODE_USE_FOUNDRY",
      "apiKeyHelper",
      "keychain",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });
});
