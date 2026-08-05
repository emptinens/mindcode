import { getModelRequestCount, getModelUsage } from "../../bootstrap/state.js";
import { getVexzyModelCatalogState } from "../api/vexzy/modelCatalog.js";

export type CreditUsage = {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  outputTokens: number;
};

export type CreditBreakdown = CreditUsage & {
  priceCreditsPerMillion: number | null;
  inputCredits: number;
  cacheCredits: number;
  reasoningCredits: number;
  outputCredits: number;
  totalCredits: number | null;
};

export type ModelCreditUsage = CreditBreakdown & {
  model: string;
  requests: number;
};

export const VEXZY_CREDIT_DIVISORS = {
  input: 8,
  cache: 40,
  reasoning: 2,
  output: 1,
} as const;

function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

export function calculateVexzyCredits(
  usage: CreditUsage,
  priceCreditsPerMillion: number | null,
): CreditBreakdown {
  const normalized = {
    inputTokens: nonNegative(usage.inputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadTokens),
    cacheWriteTokens: nonNegative(usage.cacheWriteTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
    outputTokens: nonNegative(usage.outputTokens),
  };
  const price =
    typeof priceCreditsPerMillion === "number" &&
    Number.isFinite(priceCreditsPerMillion) &&
    priceCreditsPerMillion >= 0
      ? priceCreditsPerMillion
      : null;
  const inputCredits =
    ((normalized.inputTokens / 1_000_000) * (price ?? 0)) /
    VEXZY_CREDIT_DIVISORS.input;
  const cacheCredits =
    (((normalized.cacheReadTokens + normalized.cacheWriteTokens) / 1_000_000) *
      (price ?? 0)) /
    VEXZY_CREDIT_DIVISORS.cache;
  const reasoningCredits =
    ((normalized.reasoningTokens / 1_000_000) * (price ?? 0)) /
    VEXZY_CREDIT_DIVISORS.reasoning;
  const outputCredits =
    ((normalized.outputTokens / 1_000_000) * (price ?? 0)) /
    VEXZY_CREDIT_DIVISORS.output;
  return {
    ...normalized,
    priceCreditsPerMillion: price,
    inputCredits,
    cacheCredits,
    reasoningCredits,
    outputCredits,
    totalCredits:
      price === null
        ? null
        : inputCredits + cacheCredits + reasoningCredits + outputCredits,
  };
}

function usageForModel(value: unknown): CreditUsage {
  const usage = value as Record<string, unknown>;
  return {
    inputTokens: nonNegative(usage.inputTokens),
    cacheReadTokens: nonNegative(usage.cacheReadInputTokens),
    cacheWriteTokens: nonNegative(usage.cacheCreationInputTokens),
    reasoningTokens: nonNegative(usage.reasoningTokens),
    outputTokens: nonNegative(usage.outputTokens),
  };
}

export function getSessionModelCredits(): ModelCreditUsage[] {
  const registry = getVexzyModelCatalogState().registry;
  const requests = getModelRequestCount();
  const modelUsage = getModelUsage() as Record<string, unknown>;
  const result: ModelCreditUsage[] = [];
  for (const [model, value] of Object.entries(modelUsage)) {
    const usage = usageForModel(value);
    const price = registry?.get(model)?.outputCreditsPerMillion ?? null;
    const breakdown = calculateVexzyCredits(usage, price);
    result.push({ model, requests: requests[model] ?? 0, ...breakdown });
  }
  return result;
}

export function getSessionCreditTotals(): CreditBreakdown & {
  requests: number;
  modelsWithoutPrice: number;
} {
  const models = getSessionModelCredits();
  const totals = models.reduce(
    (acc, model) => {
      acc.inputTokens += model.inputTokens;
      acc.cacheReadTokens += model.cacheReadTokens;
      acc.cacheWriteTokens += model.cacheWriteTokens;
      acc.reasoningTokens += model.reasoningTokens;
      acc.outputTokens += model.outputTokens;
      acc.inputCredits += model.inputCredits;
      acc.cacheCredits += model.cacheCredits;
      acc.reasoningCredits += model.reasoningCredits;
      acc.outputCredits += model.outputCredits;
      acc.requests += model.requests;
      acc.modelsWithoutPrice += model.priceCreditsPerMillion === null ? 1 : 0;
      if (model.totalCredits !== null) acc.totalCredits += model.totalCredits;
      return acc;
    },
    {
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      outputTokens: 0,
      priceCreditsPerMillion: null,
      inputCredits: 0,
      cacheCredits: 0,
      reasoningCredits: 0,
      outputCredits: 0,
      totalCredits: 0,
      requests: 0,
      modelsWithoutPrice: 0,
    },
  );
  return {
    ...totals,
    totalCredits:
      totals.modelsWithoutPrice > 0 &&
      models.every((model) => model.totalCredits === null)
        ? null
        : totals.totalCredits,
  };
}

export function formatVexzyCredits(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(value < 0.01 ? 6 : 4);
}
