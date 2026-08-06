import { createHash } from "node:crypto";

export const PROMPT_POLICY_SCHEMA = "prompt-policy/1" as const;

export type PromptTarget = "leader" | "worker" | "compact" | "resume";
export type JailbreakLevel = "disabled" | "lowered" | "full";

export const DEFAULT_MAX_COMPILED_PROMPT_BYTES = 128 * 1024;
export const ABSOLUTE_MAX_COMPILED_PROMPT_BYTES = 1024 * 1024;

export interface PromptSectionInput {
  readonly id: string;
  readonly content: string;
}

export interface PromptCompilerInput {
  readonly target: PromptTarget;
  readonly sections: readonly PromptSectionInput[];
  readonly jailbreakLevel: JailbreakLevel;
  readonly policyEpoch: number;
  readonly maxCompiledPromptBytes?: number;
}

export interface PromptPolicySection {
  readonly id: string;
  readonly content: string;
}

export interface PromptPolicySnapshot {
  readonly schema: typeof PROMPT_POLICY_SCHEMA;
  readonly target: PromptTarget;
  readonly jailbreakLevel: JailbreakLevel;
  readonly policyEpoch: number;
  readonly sections: readonly PromptPolicySection[];
  readonly prompt: string;
  readonly promptBytes: number;
  readonly maxCompiledPromptBytes: number;
  readonly digest: string;
}

export type PromptCompilerErrorCode =
  | "invalid_input"
  | "invalid_target"
  | "invalid_jailbreak_level"
  | "invalid_policy_epoch"
  | "invalid_section"
  | "invalid_max_size"
  | "prompt_too_large";

export class PromptCompilerError extends Error {
  readonly code: PromptCompilerErrorCode;

  constructor(code: PromptCompilerErrorCode, message: string) {
    super(message);
    this.name = "PromptCompilerError";
    this.code = code;
  }
}

const TARGETS: readonly PromptTarget[] = [
  "leader",
  "worker",
  "compact",
  "resume",
];
const JAILBREAK_LEVELS: readonly JailbreakLevel[] = [
  "disabled",
  "lowered",
  "full",
];
const encoder = new TextEncoder();

function fail(code: PromptCompilerErrorCode, message: string): never {
  throw new PromptCompilerError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, "\n");
}

function normalizeSection(
  value: unknown,
  index: number,
): PromptPolicySection | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.content !== "string"
  ) {
    fail(
      "invalid_section",
      `sections[${index}] must contain string id and content fields`,
    );
  }

  const id = normalizeLineEndings(value.id).trim();
  const content = normalizeLineEndings(value.content).trim();

  if (content.length === 0) return undefined;
  if (id.length === 0) {
    fail("invalid_section", `sections[${index}] has content but an empty id`);
  }

  return Object.freeze({ id, content });
}

function normalizeSections(
  sections: readonly PromptSectionInput[],
): readonly PromptPolicySection[] {
  const normalized: PromptPolicySection[] = [];
  const seen = new Set<string>();

  sections.forEach((section, index) => {
    const item = normalizeSection(section, index);
    if (item === undefined) return;

    const identity = `${JSON.stringify(item.id)}\u0000${JSON.stringify(item.content)}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    normalized.push(item);
  });

  return Object.freeze(normalized);
}

function validateInput(input: PromptCompilerInput): void {
  if (!isRecord(input))
    fail("invalid_input", "compiler input must be an object");
  if (!TARGETS.includes(input.target as PromptTarget)) {
    fail(
      "invalid_target",
      `unsupported prompt target: ${String(input.target)}`,
    );
  }
  if (!JAILBREAK_LEVELS.includes(input.jailbreakLevel as JailbreakLevel)) {
    fail(
      "invalid_jailbreak_level",
      `unsupported jailbreak level: ${String(input.jailbreakLevel)}`,
    );
  }
  if (!Array.isArray(input.sections)) {
    fail("invalid_input", "sections must be an array");
  }
  if (
    typeof input.policyEpoch !== "number" ||
    !Number.isSafeInteger(input.policyEpoch) ||
    input.policyEpoch < 0
  ) {
    fail(
      "invalid_policy_epoch",
      "policyEpoch must be a nonnegative safe integer",
    );
  }
}

function resolveMaxPromptBytes(value: number | undefined): number {
  const maxPromptBytes = value ?? DEFAULT_MAX_COMPILED_PROMPT_BYTES;
  if (
    !Number.isSafeInteger(maxPromptBytes) ||
    maxPromptBytes <= 0 ||
    maxPromptBytes > ABSOLUTE_MAX_COMPILED_PROMPT_BYTES
  ) {
    fail(
      "invalid_max_size",
      `maxCompiledPromptBytes must be an integer in the range 1..${ABSOLUTE_MAX_COMPILED_PROMPT_BYTES}`,
    );
  }
  return maxPromptBytes;
}

function compileSections(sections: readonly PromptPolicySection[]): string {
  return sections
    .map((section) => `## ${section.id}\n${section.content}`)
    .join("\n\n");
}

function digestFor(snapshot: {
  readonly schema: typeof PROMPT_POLICY_SCHEMA;
  readonly target: PromptTarget;
  readonly jailbreakLevel: JailbreakLevel;
  readonly policyEpoch: number;
  readonly sections: readonly PromptPolicySection[];
  readonly prompt: string;
  readonly maxCompiledPromptBytes: number;
}): string {
  const canonical = JSON.stringify({
    schema: snapshot.schema,
    target: snapshot.target,
    jailbreak_level: snapshot.jailbreakLevel,
    policy_epoch: snapshot.policyEpoch,
    sections: snapshot.sections,
    prompt: snapshot.prompt,
    max_compiled_prompt_bytes: snapshot.maxCompiledPromptBytes,
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function compilePromptPolicy(
  input: PromptCompilerInput,
): PromptPolicySnapshot {
  validateInput(input);
  const maxCompiledPromptBytes = resolveMaxPromptBytes(
    input.maxCompiledPromptBytes,
  );
  const sections = normalizeSections(input.sections);
  const prompt = compileSections(sections);
  const promptBytes = encoder.encode(prompt).byteLength;

  if (promptBytes > maxCompiledPromptBytes) {
    fail(
      "prompt_too_large",
      `compiled prompt is ${promptBytes} bytes; limit is ${maxCompiledPromptBytes}`,
    );
  }

  const snapshot = {
    schema: PROMPT_POLICY_SCHEMA,
    target: input.target,
    jailbreakLevel: input.jailbreakLevel,
    policyEpoch: input.policyEpoch,
    sections,
    prompt,
    promptBytes,
    maxCompiledPromptBytes,
    digest: "",
  } satisfies Omit<PromptPolicySnapshot, "digest"> & { digest: string };

  const completed = {
    ...snapshot,
    digest: digestFor(snapshot),
  };

  return Object.freeze(completed);
}

export const compilePrompt = compilePromptPolicy;

export class PromptCompiler {
  readonly maxCompiledPromptBytes: number;

  constructor(maxCompiledPromptBytes = DEFAULT_MAX_COMPILED_PROMPT_BYTES) {
    this.maxCompiledPromptBytes = resolveMaxPromptBytes(maxCompiledPromptBytes);
    Object.freeze(this);
  }

  compile(
    input: Omit<PromptCompilerInput, "maxCompiledPromptBytes">,
  ): PromptPolicySnapshot {
    return compilePromptPolicy({
      ...input,
      maxCompiledPromptBytes: this.maxCompiledPromptBytes,
    });
  }
}
