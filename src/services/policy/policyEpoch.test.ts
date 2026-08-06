import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentSessionSidecarPath } from "../../utils/sessionSidecar.js";
import {
  POLICY_DIGEST_ENV_VAR,
  POLICY_EPOCH_ENV_VAR,
  POLICY_EPOCH_SCHEMA,
  PolicyEpochError,
  assertWorkerPolicyIdentity,
  computePolicySourceDigest,
  getPolicyEpochFromEnvironment,
  parsePolicyEpochEnvironment,
  parsePolicyEpochState,
  readCurrentPolicyEpochState,
  registerCompiledPolicyDigest,
  resolvePolicyEpochForSource,
} from "./policyEpoch.js";

const originalConfigDir = process.env.MINDCODE_CONFIG_DIR;
const testDirectories: string[] = [];

function useIsolatedSession(): string {
  const directory = join(
    tmpdir(),
    `mindcode-policy-epoch-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  testDirectories.push(directory);
  process.env.MINDCODE_CONFIG_DIR = directory;
  return getCurrentSessionSidecarPath(".policy-epoch");
}

afterEach(() => {
  if (originalConfigDir === undefined)
    Reflect.deleteProperty(process.env, "MINDCODE_CONFIG_DIR");
  else process.env.MINDCODE_CONFIG_DIR = originalConfigDir;
  for (const directory of testDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("policy epoch state", () => {
  test("requires the complete Worker epoch and source digest pair", () => {
    const identity = assertWorkerPolicyIdentity({
      policyEpoch: 4,
      policyDigest: "a".repeat(64),
    })
    expect(identity).toEqual({
      policyEpoch: 4,
      policyDigest: "a".repeat(64),
    })
    expect(Object.isFrozen(identity)).toBe(true)
    expect(() => assertWorkerPolicyIdentity({ policyDigest: "a".repeat(64) })).toThrow(
      "policy epoch must be a nonnegative safe integer",
    )
    expect(() => assertWorkerPolicyIdentity({ policyEpoch: 4 })).toThrow(
      "policy source digest must be a lowercase SHA-256 digest",
    )
    expect(() =>
      assertWorkerPolicyIdentity({
        policyEpoch: 4,
        policyDigest: "A".repeat(64),
      }),
    ).toThrow("policy source digest must be a lowercase SHA-256 digest")
  })

  test("registers an immutable state and is idempotent for the same digest and level", () => {
    useIsolatedSession();

    const first = registerCompiledPolicyDigest("digest-a", "lowered");
    const second = registerCompiledPolicyDigest("digest-a", "lowered");

    expect(first).toEqual({
      schema_version: POLICY_EPOCH_SCHEMA,
      epoch: 0,
      digest: "digest-a",
      jailbreak_level: "lowered",
      updated_at: first.updated_at,
    });
    expect(second).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(readCurrentPolicyEpochState()).toEqual(first);
  });

  test("increments exactly once for each policy or jailbreak change", () => {
    useIsolatedSession();

    const initial = registerCompiledPolicyDigest("digest-a", "lowered");
    const levelChange = registerCompiledPolicyDigest("digest-a", "full");
    const digestChange = registerCompiledPolicyDigest("digest-b", "full");
    const repeated = registerCompiledPolicyDigest("digest-b", "full");

    expect(initial.epoch).toBe(0);
    expect(levelChange.epoch).toBe(1);
    expect(digestChange.epoch).toBe(2);
    expect(repeated.epoch).toBe(2);
    expect(Date.parse(levelChange.updated_at)).toBeGreaterThan(
      Date.parse(initial.updated_at),
    );
    expect(Date.parse(digestChange.updated_at)).toBeGreaterThan(
      Date.parse(levelChange.updated_at),
    );
  });

  test("strictly rejects corrupt state without replacing the file", () => {
    const path = useIsolatedSession();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    const corrupt = '{"schema_version":"policy-epoch/1","epoch":-1}';
    writeFileSync(path, corrupt, { mode: 0o600 });

    expect(() => readCurrentPolicyEpochState()).toThrow(
      "could not parse policy epoch state",
    );
    expect(() => registerCompiledPolicyDigest("digest-a", "lowered")).toThrow(
      PolicyEpochError,
    );
    expect(readFileSync(path, "utf8")).toBe(corrupt);
    expect(parsePolicyEpochState({})).toBeUndefined();
  });

  test("treats an existing unreadable sidecar as a hard failure", () => {
    const path = useIsolatedSession();
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    mkdirSync(path);

    expect(() => readCurrentPolicyEpochState()).toThrow(PolicyEpochError);
  });

  test("returns no state only when the sidecar is absent", () => {
    useIsolatedSession();

    expect(readCurrentPolicyEpochState()).toBeUndefined();
  });

  test("fails closed for missing, partial, malformed, and unsafe inherited data", () => {
    const valid = {
      [POLICY_EPOCH_ENV_VAR]: "12",
      [POLICY_DIGEST_ENV_VAR]: "digest-a",
    };
    expect(parsePolicyEpochEnvironment({})).toBeUndefined();
    expect(parsePolicyEpochEnvironment(valid)).toEqual({
      epoch: 12,
      digest: "digest-a",
    });
    expect(
      parsePolicyEpochEnvironment({ [POLICY_EPOCH_ENV_VAR]: "12" }),
    ).toBeUndefined();
    expect(
      parsePolicyEpochEnvironment({
        ...valid,
        [POLICY_EPOCH_ENV_VAR]: "-1",
      }),
    ).toBeUndefined();
    expect(
      parsePolicyEpochEnvironment({
        ...valid,
        [POLICY_EPOCH_ENV_VAR]: "9007199254740992",
      }),
    ).toBeUndefined();
    expect(
      parsePolicyEpochEnvironment({
        ...valid,
        [POLICY_DIGEST_ENV_VAR]: "digest with spaces",
      }),
    ).toBeUndefined();
    expect(getPolicyEpochFromEnvironment(valid)).toEqual({
      epoch: 12,
      digest: "digest-a",
    });
  });

  test("uses a private parent directory and state file", () => {
    const path = useIsolatedSession();
    const state = registerCompiledPolicyDigest("digest-a", "lowered");
    const parentMode = statSync(join(path, "..")).mode & 0o777;
    const fileMode = statSync(path).mode & 0o777;

    expect(state.schema_version).toBe(POLICY_EPOCH_SCHEMA);
    expect(parentMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
    expect(
      readdirSync(join(path, "..")).some((name) => name.endsWith(".tmp")),
    ).toBe(false);
  });

  test("serializes concurrent registrations in one process", async () => {
    useIsolatedSession();

    const states = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        Promise.resolve().then(() =>
          registerCompiledPolicyDigest(`digest-${index}`, "lowered"),
        ),
      ),
    );
    const epochs = states.map((state) => state.epoch).sort((a, b) => a - b);

    expect(epochs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(readCurrentPolicyEpochState()?.epoch).toBe(7);
  });

  test("rejects malformed registration input before touching storage", () => {
    const path = useIsolatedSession();
    expect(() => registerCompiledPolicyDigest("", "lowered")).toThrow(
      PolicyEpochError,
    );
    expect(() =>
      registerCompiledPolicyDigest("digest-a", "unknown" as never),
    ).toThrow(PolicyEpochError);
    expect(() => statSync(path)).toThrow();
  });

  test("derives a target-independent digest and validates inherited epochs", () => {
    const sections = [
      { id: "leader", content: "Lead." },
      { id: "worker", content: "Execute." },
    ];
    const digest = computePolicySourceDigest(sections, "lowered");
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(
      computePolicySourceDigest(
        sections.map((section) => ({ ...section })),
        "lowered",
      ),
    ).toBe(digest);
    expect(computePolicySourceDigest(sections, "full")).not.toBe(digest);

    expect(
      resolvePolicyEpochForSource(digest, "lowered", {
        [POLICY_EPOCH_ENV_VAR]: "17",
        [POLICY_DIGEST_ENV_VAR]: digest,
      }),
    ).toEqual({ epoch: 17, digest });
    expect(() =>
      resolvePolicyEpochForSource(digest, "lowered", {
        [POLICY_EPOCH_ENV_VAR]: "17",
        [POLICY_DIGEST_ENV_VAR]: "other-digest",
      }),
    ).toThrow("inherited policy digest mismatch");
    expect(() =>
      resolvePolicyEpochForSource(digest, "lowered", {
        [POLICY_EPOCH_ENV_VAR]: "17",
      }),
    ).toThrow("malformed inherited policy epoch");
  });
});
