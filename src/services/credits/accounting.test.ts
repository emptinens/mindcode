import { describe, expect, test } from "bun:test";
import { VEXZY_CREDIT_DIVISORS, calculateVexzyCredits } from "./accounting.js";

describe("VEXZY credit accounting", () => {
  test("applies the documented output-price multipliers", () => {
    const price = 1_000;
    const result = calculateVexzyCredits(
      {
        inputTokens: 1_000_000,
        cacheReadTokens: 2_000_000,
        cacheWriteTokens: 1_000_000,
        reasoningTokens: 4_000_000,
        outputTokens: 5_000_000,
      },
      price,
    );

    expect(VEXZY_CREDIT_DIVISORS).toEqual({
      input: 8,
      cache: 40,
      reasoning: 2,
      output: 1,
    });
    expect(result.inputCredits).toBe(125);
    expect(result.cacheCredits).toBe(75);
    expect(result.reasoningCredits).toBe(2_000);
    expect(result.outputCredits).toBe(5_000);
    expect(result.totalCredits).toBe(7_200);
  });

  test("returns an unknown total when catalog pricing is unavailable", () => {
    const result = calculateVexzyCredits(
      {
        inputTokens: 1_000_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        outputTokens: 1_000_000,
      },
      null,
    );

    expect(result.priceCreditsPerMillion).toBeNull();
    expect(result.totalCredits).toBeNull();
    expect(result.inputCredits).toBe(0);
    expect(result.outputCredits).toBe(0);
  });

  test("clamps malformed usage values instead of producing NaN", () => {
    const result = calculateVexzyCredits(
      {
        inputTokens: -1,
        cacheReadTokens: Number.NaN,
        cacheWriteTokens: Number.POSITIVE_INFINITY,
        reasoningTokens: -10,
        outputTokens: 100,
      },
      37,
    );

    expect(result.inputTokens).toBe(0);
    expect(result.cacheReadTokens).toBe(0);
    expect(result.cacheWriteTokens).toBe(0);
    expect(result.reasoningTokens).toBe(0);
    expect(result.outputTokens).toBe(100);
    expect(result.totalCredits).toBe(0.0037);
  });
});
