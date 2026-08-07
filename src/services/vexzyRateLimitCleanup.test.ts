import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

describe("VEXZY rate-limit cleanup", () => {
  test("removes provider-only mock and footer modules", () => {
    for (const relativePath of [
      "services/mockRateLimits.ts",
      "services/rateLimitMocking.ts",
      "hooks/notifs/useRateLimitWarningNotification.tsx",
      "services/claudeAiLimits.ts",
    ]) {
      expect(existsSync(resolve(root, relativePath))).toBe(false);
    }
  });

  test("targeted runtime sources contain no removed provider paths", () => {
    const files = [
      "screens/REPL.tsx",
      "components/PromptInput/Notifications.tsx",
      "services/rateLimitMessages.ts",
      "services/api/withRetry.ts",
      "services/vexzyLimits.ts",
      "services/vexzyLimitsHook.ts",
      "commands/cost/cost.ts",
      "commands/cost/index.ts",
      "services/api/modelRuntime.ts",
      "services/api/promptCacheBreakDetection.ts",
      "utils/messages/mappers.ts",
      "entrypoints/sdk/coreSchemas.ts",
      "utils/billing.ts",
      "utils/fastMode.ts",
      "utils/model/check1mAccess.ts",
      "constants/oauth.ts",
    ];
    const forbidden = [
      "anthropic-ratelimit-unified",
      "cachedExtraUsageDisabledReason",
      "extra_usage_disabled",
      "getUsingOverageText",
      "mock-limits",
      "CLAUDE_AI_",
      "CLAUDEAI_",
      "platform.claude.com",
      "isClaudeAISubscriber",
      "getSubscriptionType",
      ["isUsing", "Overage"].join(""),
      ["overage", "Status"].join(""),
      ["overage", "ResetsAt"].join(""),
      ["overage", "DisabledReason"].join(""),
    ];

    for (const relativePath of files) {
      const source = read(relativePath);
      for (const residue of forbidden) {
        expect(source, `${relativePath} contains ${residue}`).not.toContain(
          residue,
        );
      }
    }
  });

  test("cost command is local VEXZY accounting only", () => {
    const cost = read("commands/cost/cost.ts");
    const index = read("commands/cost/index.ts");
    expect(cost).toContain("getSessionCreditTotals");
    expect(cost).toContain("formatVexzyCredits");
    expect(cost).not.toContain("formatTotalCost");
    expect(index).not.toContain("isHidden");
    expect(index).not.toContain("isClaudeAISubscriber");
  });

  test("preserves VEXZY credits and generic fast-mode retry paths", () => {
    const credits = read("services/credits/accounting.ts");
    const retry = read("services/api/withRetry.ts");
    expect(credits).toContain("VEXZY_CREDIT_DIVISORS");
    expect(credits).toContain("getSessionCreditTotals");
    expect(retry).toContain("getRetryAfter");
    expect(retry).toContain("triggerFastModeCooldown");
    expect(retry).not.toContain("checkMockRateLimitError");
  });
});
