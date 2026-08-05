import { describe, expect, test } from "bun:test";
import { normalizeRuntimeContentBlocks } from "./runtimeContentBlocks.js";

describe("normalizeRuntimeContentBlocks", () => {
  test("keeps a valid content block array", () => {
    const blocks = [{ type: "text" as const, text: "ok" }];
    expect(normalizeRuntimeContentBlocks(blocks)).toEqual(blocks);
  });

  test("wraps a legacy single-block payload", () => {
    const block = { type: "text" as const, text: "agent result" };
    expect(normalizeRuntimeContentBlocks(block)).toEqual([block]);
  });

  test("drops invalid values instead of exposing them to array methods", () => {
    expect(normalizeRuntimeContentBlocks(undefined)).toEqual([]);
    expect(normalizeRuntimeContentBlocks({ content: "not a block" })).toEqual(
      [],
    );
    expect(
      normalizeRuntimeContentBlocks([null, { type: "text", text: "ok" }]),
    ).toEqual([{ type: "text", text: "ok" }]);
  });
});
