import {
  formatVexzyCredits,
  getSessionCreditTotals,
} from "../../services/credits/accounting.js";
import type { LocalCommandCall } from "../../types/command.js";

export const call: LocalCommandCall = async () => {
  const totals = getSessionCreditTotals();
  const unavailable =
    totals.modelsWithoutPrice > 0 ? " · catalog price unavailable" : "";

  return {
    type: "text",
    value: [
      `VEXZY session credits: ${formatVexzyCredits(totals.totalCredits)}${unavailable}`,
      `Requests: ${totals.requests}`,
      `Input: ${totals.inputTokens} tokens · ${formatVexzyCredits(totals.inputCredits)} credits`,
      `Cache: ${totals.cacheReadTokens + totals.cacheWriteTokens} tokens · ${formatVexzyCredits(totals.cacheCredits)} credits`,
      `Reasoning: ${totals.reasoningTokens} tokens · ${formatVexzyCredits(totals.reasoningCredits)} credits`,
      `Output: ${totals.outputTokens} tokens · ${formatVexzyCredits(totals.outputCredits)} credits`,
    ].join("\n"),
  };
};
