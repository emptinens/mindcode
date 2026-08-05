import { describe, expect, test } from "bun:test";
import type {
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaToolUnion,
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
  VexzyClient,
} from "./protocolTypes.js";

describe("VEXZY protocol types", () => {
  test("accept the Anthropic-compatible request shapes used by the runtime", () => {
    const tool: BetaToolUnion = {
      name: "read",
      description: "Read a file",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    };
    const message: BetaMessageParam = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        {
          type: "tool_result",
          tool_use_id: "tool-1",
          content: [{ type: "text", text: "ok" }],
        },
      ],
    };
    const params: BetaMessageStreamParams = {
      model: "gpt-5.6-luna",
      max_tokens: 128,
      messages: [message],
      tools: [tool],
      reasoning_effort: "high",
    };
    expect(params.messages).toHaveLength(1);
  });

  test("keeps tool-use response fields structurally typed", () => {
    const block: ToolUseBlock = {
      type: "tool_use",
      id: "tool-1",
      name: "read",
      input: { path: "README.md" },
    };
    const result: ToolResultBlockParam = {
      type: "tool_result",
      tool_use_id: block.id,
      content: [{ type: "text", text: "ok" }],
    };
    const content: ContentBlockParam = result;
    expect(content.type).toBe("tool_result");
  });

  test("exposes a VEXZY client contract without SDK package types", () => {
    const client: VexzyClient = {} as VexzyClient;
    expect(client).toBeDefined();
  });
});
