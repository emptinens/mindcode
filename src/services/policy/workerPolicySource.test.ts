import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setJailbreakLevel } from "../../utils/jailbreak.js";
import { POLICY_DIGEST_ENV_VAR, POLICY_EPOCH_ENV_VAR } from "./policyEpoch.js";
import {
  getCompiledWorkerPolicySnapshot,
  getWorkerPolicySourceDigest,
} from "./workerPolicySource.js";

const originalConfigDir = process.env.MINDCODE_CONFIG_DIR;
const originalPolicyEpoch = process.env[POLICY_EPOCH_ENV_VAR];
const originalPolicyDigest = process.env[POLICY_DIGEST_ENV_VAR];
const originalJailbreak = process.env.MINDCODE_JAILBREAK_LEVEL;
const isolatedDirectories: string[] = [];

function isolatePolicySession(): void {
  const directory = mkdtempSync(join(tmpdir(), "mindcode-worker-policy-"));
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

describe("compiled Worker policy source", () => {
  test("produces a stable golden snapshot and source digest", () => {
    isolatePolicySession();

    const snapshot = getCompiledWorkerPolicySnapshot("lowered");
    expect(snapshot.target).toBe("worker");
    expect(snapshot.policyEpoch).toBe(0);
    expect(snapshot.sourceDigest).toBe(getWorkerPolicySourceDigest("lowered"));
    expect(snapshot.sourceDigest).toBe(
      "faccd52f7e31a7743d4a002a37b9cf9b191c843ac80e87ab833f6f0ac1c9ef7c",
    );
    expect(snapshot.prompt).toContain("gpt-5.6-luna");
    expect(Object.isFrozen(snapshot)).toBe(true);
  });

  test("advances once for a jailbreak change and preserves the Leader epoch", () => {
    isolatePolicySession();

    const leader = getCompiledWorkerPolicySnapshot("lowered");
    setJailbreakLevel("full");
    const changed = getCompiledWorkerPolicySnapshot("full");
    const repeated = getCompiledWorkerPolicySnapshot("full");

    expect(changed.policyEpoch).toBe(leader.policyEpoch + 1);
    expect(repeated.policyEpoch).toBe(changed.policyEpoch);
    expect(changed.sourceDigest).not.toBe(leader.sourceDigest);

    process.env.MINDCODE_JAILBREAK_LEVEL = "full";
    process.env[POLICY_EPOCH_ENV_VAR] = String(changed.policyEpoch);
    process.env[POLICY_DIGEST_ENV_VAR] = changed.sourceDigest;
    const worker = getCompiledWorkerPolicySnapshot("full");
    expect(worker.policyEpoch).toBe(changed.policyEpoch);
    expect(worker.sourceDigest).toBe(changed.sourceDigest);

    process.env[POLICY_DIGEST_ENV_VAR] = "wrong-digest";
    expect(() => getCompiledWorkerPolicySnapshot("full")).toThrow(
      "inherited policy digest mismatch",
    );
  });

  test("fails closed for malformed inherited state", () => {
    isolatePolicySession();
    process.env[POLICY_EPOCH_ENV_VAR] = "3";

    expect(() => getCompiledWorkerPolicySnapshot("lowered")).toThrow(
      "malformed inherited policy epoch",
    );
  });
});
