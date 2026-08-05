import { describe, expect, test } from "bun:test";
import { generateContinuationPrompt } from "./generator.js";
import { buildContinuationSource, redactSecrets } from "./source.js";

describe("/copycon source", () => {
  test("redacts Vexzy credentials and bearer tokens", () => {
    const result = redactSecrets(
      "VEXZY_API_KEY=forge-super-secret Bearer abc.def.ghi x-api-key: hidden",
    );
    expect(result).not.toContain("forge-super-secret");
    expect(result).not.toContain("abc.def.ghi");
    expect(result).not.toContain("hidden");
    expect(result).toContain("[REDACTED]");
  });

  test("keeps structured bounded session material and omits tool dumps", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      type: index % 2 === 0 ? "user" : "assistant",
      message: { content: [{ type: "text", text: `message ${index}` }] },
    })) as never[];
    const source = buildContinuationSource({
      messages,
      cwd: "/tmp/project",
      gitStatus: " M src/main.ts",
      gitDiffStat: " src/main.ts | 2 ++",
    });
    expect(source.length).toBeLessThanOrEqual(18_000);
    expect(source).toContain("Рабочая директория: /tmp/project");
    expect(source).toContain("message 29");
    expect(source).not.toContain("tool_use");
  });

  test("keeps the original task after a long session and includes the latest compact summary", () => {
    const messages = [
      {
        type: "user",
        message: { content: [{ type: "text", text: "ORIGINAL TASK" }] },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        type: index % 2 === 0 ? "assistant" : "user",
        message: { content: [{ type: "text", text: `later ${index}` }] },
      })),
      {
        type: "user",
        isCompactSummary: true,
        message: { content: [{ type: "text", text: "COMPACT STATE" }] },
      },
    ] as never[];

    const source = buildContinuationSource({ messages, cwd: "/tmp/project" });
    expect(source).toContain("Задача сессии: ORIGINAL TASK");
    expect(source).toContain("Последний compact summary:\nCOMPACT STATE");
  });

  test("excludes meta transcript material from the portable source", () => {
    const source = buildContinuationSource({
      messages: [
        {
          type: "user",
          isMeta: true,
          message: {
            content: [{ type: "text", text: "INTERNAL SYSTEM REMINDER" }],
          },
        },
        {
          type: "user",
          message: { content: [{ type: "text", text: "real task" }] },
        },
      ] as never[],
      cwd: "/tmp/project",
    });
    expect(source).toContain("real task");
    expect(source).not.toContain("INTERNAL SYSTEM REMINDER");
  });

  test("uses fixed Luna model and medium effort with a mocked query", async () => {
    let seen: { model?: string; effort?: string } = {};
    const prompt = await generateContinuationPrompt(
      "source",
      "",
      async (options) => {
        seen = options;
        return {
          content: [{ type: "text", text: "Продолжи с проверки тестов." }],
        } as never;
      },
    );
    expect(prompt).toContain("Продолжи");
    expect(seen).toMatchObject({ model: "gpt-5.6-luna", effort: "medium" });
  });

  test("redacts and bounds generated output before copying", async () => {
    const prompt = await generateContinuationPrompt(
      "source",
      "",
      async () =>
        ({
          content: [
            {
              type: "text",
              text: `forge-output-secret ${"x".repeat(30_000)}`,
            },
          ],
        }) as never,
    );
    expect(prompt).not.toContain("forge-output-secret");
    expect(prompt.length).toBeLessThanOrEqual(24_000);
  });

  test("redacts the optional focus before sending it to Luna", async () => {
    let seen = "";
    await generateContinuationPrompt(
      "source",
      "forge-focus-secret",
      async (options) => {
        seen = JSON.stringify(options);
        return { content: [{ type: "text", text: "continue" }] } as never;
      },
    );
    expect(seen).not.toContain("forge-focus-secret");
    expect(seen).toContain("[REDACTED]");
  });
});
