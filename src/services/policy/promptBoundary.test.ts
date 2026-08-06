import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { POLICY_DIGEST_ENV_VAR, POLICY_EPOCH_ENV_VAR } from "./policyEpoch.js";
import {
  compilePromptBoundary,
  getCompiledCompactPolicySnapshot,
  getCompiledLeaderPolicySnapshot,
  getCompiledResumePolicySnapshot,
  getCompiledWorkerPolicySnapshot,
} from "./promptBoundary.js";

const originalConfigDir = process.env.MINDCODE_CONFIG_DIR;
const originalPolicyEpoch = process.env[POLICY_EPOCH_ENV_VAR];
const originalPolicyDigest = process.env[POLICY_DIGEST_ENV_VAR];
const originalJailbreak = process.env.MINDCODE_JAILBREAK_LEVEL;
const isolatedDirectories: string[] = [];

function isolatePolicySession(): void {
  const directory = mkdtempSync(join(tmpdir(), "mindcode-prompt-boundary-"));
  isolatedDirectories.push(directory);
  process.env.MINDCODE_CONFIG_DIR = directory;
  Reflect.deleteProperty(process.env, POLICY_EPOCH_ENV_VAR);
  Reflect.deleteProperty(process.env, POLICY_DIGEST_ENV_VAR);
  Reflect.deleteProperty(process.env, "MINDCODE_JAILBREAK_LEVEL");
}

afterEach(() => {
  if (originalConfigDir === undefined)
    Reflect.deleteProperty(process.env, "MINDCODE_CONFIG_DIR");
  else process.env.MINDCODE_CONFIG_DIR = originalConfigDir;

  for (const [name, value] of [
    [POLICY_EPOCH_ENV_VAR, originalPolicyEpoch],
    [POLICY_DIGEST_ENV_VAR, originalPolicyDigest],
    ["MINDCODE_JAILBREAK_LEVEL", originalJailbreak],
  ] as const) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }

  for (const directory of isolatedDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("compiled prompt boundaries", () => {
  test("keeps target, order, jailbreak, epoch, and shared source identity stable", () => {
    isolatePolicySession();

    const leader = getCompiledLeaderPolicySnapshot("lowered");
    const worker = getCompiledWorkerPolicySnapshot("lowered");
    const compact = getCompiledCompactPolicySnapshot(
      "You are a helpful AI assistant tasked with summarizing conversations.",
      "lowered",
    );
    const resume = getCompiledResumePolicySnapshot("lowered");

    expect(leader).toMatchObject({
      schema: "prompt-policy/1",
      target: "leader",
      jailbreakLevel: "lowered",
      policyEpoch: 0,
      sourceDigest:
        "faccd52f7e31a7743d4a002a37b9cf9b191c843ac80e87ab833f6f0ac1c9ef7c",
    });
    expect(worker).toMatchObject({
      target: "worker",
      digest:
        "491d459f4cd46d86bff0e72926665374a81885abb27601333404974dae8f7e6c",
    });
    expect(compact).toMatchObject({
      target: "compact",
      digest:
        "1dbe24b6dbb4024493f020b022e9eacc24e22db9255ba1fd803a103a0a70cb2c",
    });
    expect(resume).toMatchObject({
      target: "resume",
      digest:
        "2cf7e57565e36c94adbdaffa64b2b17387650248a31eeae02964c1135e13775c",
    });
    expect(leader.policyEpoch).toBe(worker.policyEpoch);
    expect(worker.policyEpoch).toBe(compact.policyEpoch);
    expect(compact.policyEpoch).toBe(resume.policyEpoch);
    expect(new Set([leader.sourceDigest, worker.sourceDigest, compact.sourceDigest, resume.sourceDigest]).size).toBe(1);

    expect(leader.sections.map(section => section.id)).toEqual([
      "leader-architecture",
    ]);
    expect(worker.sections.map(section => section.id)).toEqual([
      "worker-contract",
      "injection-handling",
      "content-handling",
    ]);
    expect(compact.sections.map(section => section.id)).toEqual([
      "compact-system",
    ]);
    expect(resume.sections.map(section => section.id)).toEqual([
      "worker-contract",
      "injection-handling",
      "content-handling",
    ]);
    expect(leader.digest).toBe(
      "1bee08a8fdb86951fdcda1949f641eb61807fd88dd57a4ad28f3d0ae6a57825a",
    );
    expect(leader.digest).not.toBe(worker.digest);
    expect(compact.digest).not.toBe(resume.digest);
    expect(leader.prompt).toContain("You are the Leader");
    expect(compact.prompt).toContain("summarizing conversations");
    expect(resume.prompt).toBe(worker.prompt);
  });

  test("preserves explicit section order and makes cache metadata target-sensitive", () => {
    isolatePolicySession();

    const snapshot = compilePromptBoundary(
      "leader",
      [
        { id: "static-prefix", content: "Keep this before the dynamic tail." },
        { id: "dynamic-tail", content: "Keep this after the static prefix." },
      ],
      "full",
    );

    expect(snapshot.jailbreakLevel).toBe("full");
    expect(snapshot.policyEpoch).toBe(0);
    expect(snapshot.sections.map(section => section.id)).toEqual([
      "static-prefix",
      "dynamic-tail",
    ]);
    expect(snapshot.prompt).toBe(
      "## static-prefix\nKeep this before the dynamic tail.\n\n## dynamic-tail\nKeep this after the static prefix.",
    );
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  test("all production prompt boundaries call a target-specific compiler helper", () => {
    const sources = [
      ["leader", "../../constants/prompts.ts", "getCompiledLeaderPolicySnapshot"],
      ["compact", "../compact/compact.ts", "getCompiledCompactPolicySnapshot"],
      ["resume", "../../tools/AgentTool/resumeAgent.ts", "getCompiledResumePolicySnapshot"],
    ] as const;

    for (const [target, relativePath, helper] of sources) {
      const source = readFileSync(
        new URL(relativePath, import.meta.url),
        "utf8",
      );
      expect(source, `${target} call site`).toContain(helper);
    }
  });
});
