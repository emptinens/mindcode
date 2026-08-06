import { describe, expect, test } from "bun:test";

import {
  ABSOLUTE_MAX_COMPILED_PROMPT_BYTES,
  DEFAULT_MAX_COMPILED_PROMPT_BYTES,
  PromptCompiler,
  PromptCompilerError,
  compilePromptPolicy,
} from "./promptCompiler.js";

const baseInput = {
  target: "worker" as const,
  jailbreakLevel: "lowered" as const,
  policyEpoch: 7,
  sections: [
    { id: "worker-contract", content: "Use structured reports." },
    { id: "task", content: "Inspect the scheduler." },
  ],
};

describe("PromptCompiler", () => {
  test("produces the prompt-policy/1 golden snapshot", () => {
    const snapshot = compilePromptPolicy(baseInput);

    expect(snapshot).toMatchObject({
      schema: "prompt-policy/1",
      target: "worker",
      jailbreakLevel: "lowered",
      policyEpoch: 7,
      sections: baseInput.sections,
      prompt:
        "## worker-contract\nUse structured reports.\n\n## task\nInspect the scheduler.",
      promptBytes: 74,
      maxCompiledPromptBytes: DEFAULT_MAX_COMPILED_PROMPT_BYTES,
      digest:
        "bf5b2aa3ae0c66ef8eade86a6587e673624d82c8fd5aff9e221e56941ab289b3",
    });
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("is deterministic and returns deeply immutable output", () => {
    const first = compilePromptPolicy(baseInput);
    const second = compilePromptPolicy({
      ...baseInput,
      sections: [...baseInput.sections],
    });

    expect(first).toEqual(second);
    expect(first.digest).toBe(second.digest);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.sections)).toBe(true);
    expect(Object.isFrozen(first.sections[0])).toBe(true);
  });

  test("normalizes empty sections, line endings, and stable exact duplicates", () => {
    const snapshot = compilePromptPolicy({
      ...baseInput,
      sections: [
        { id: "  first\r\n", content: "  one\r\ntwo  " },
        { id: "empty", content: " \r\n\t " },
        { id: "first", content: "one\ntwo" },
        { id: "second", content: " three " },
        { id: "first", content: "one\ntwo" },
      ],
    });

    expect(snapshot.sections).toEqual([
      { id: "first", content: "one\ntwo" },
      { id: "second", content: "three" },
    ]);
    expect(snapshot.prompt).toBe("## first\none\ntwo\n\n## second\nthree");
  });

  test("supports every declared compilation target", () => {
    for (const target of ["leader", "worker", "compact", "resume"] as const) {
      const snapshot = compilePromptPolicy({ ...baseInput, target });
      expect(snapshot.target).toBe(target);
      expect(snapshot.schema).toBe("prompt-policy/1");
    }
  });

  test("changes digest when cache-relevant metadata or content changes", () => {
    const original = compilePromptPolicy(baseInput);
    const variants = [
      compilePromptPolicy({ ...baseInput, target: "leader" }),
      compilePromptPolicy({ ...baseInput, jailbreakLevel: "full" }),
      compilePromptPolicy({ ...baseInput, policyEpoch: 8 }),
      compilePromptPolicy({
        ...baseInput,
        sections: [{ id: "task", content: "Inspect a different path." }],
      }),
    ];

    for (const variant of variants) {
      expect(variant.digest).not.toBe(original.digest);
    }
  });

  test("enforces the explicit compiled prompt byte bound", () => {
    expect(() =>
      compilePromptPolicy({
        ...baseInput,
        maxCompiledPromptBytes: 10,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "prompt_too_large",
      }),
    );

    expect(
      () => new PromptCompiler(ABSOLUTE_MAX_COMPILED_PROMPT_BYTES + 1),
    ).toThrowError(
      expect.objectContaining({
        code: "invalid_max_size",
      }),
    );
  });

  test("validates target, jailbreak level, epoch, and section shape", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["target", { target: "other" }],
      ["jailbreak", { jailbreakLevel: "max" }],
      ["epoch", { policyEpoch: -1 }],
      ["epoch", { policyEpoch: Number.MAX_SAFE_INTEGER + 1 }],
      ["section", { sections: [{ id: "task", content: 42 }] }],
      ["section", { sections: [{ id: "  ", content: "task" }] }],
    ];

    for (const [kind, override] of cases) {
      expect(() =>
        compilePromptPolicy({ ...baseInput, ...override } as never),
      ).toThrowError(PromptCompilerError);
      expect(() =>
        compilePromptPolicy({ ...baseInput, ...override } as never),
      ).toThrowError(
        expect.objectContaining({
          code:
            kind === "target"
              ? "invalid_target"
              : kind === "jailbreak"
                ? "invalid_jailbreak_level"
                : kind === "epoch"
                  ? "invalid_policy_epoch"
                  : "invalid_section",
        }),
      );
    }
  });

  test("supports an instance-level bound without reading process state", () => {
    const compiler = new PromptCompiler(200);
    const snapshot = compiler.compile(baseInput);
    expect(snapshot.maxCompiledPromptBytes).toBe(200);
    expect(snapshot.promptBytes).toBeLessThanOrEqual(200);
  });
});
