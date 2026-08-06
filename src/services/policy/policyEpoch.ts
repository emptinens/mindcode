import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "../../utils/crypto.js";
import { getCurrentSessionSidecarPath } from "../../utils/sessionSidecar.js";

export const POLICY_EPOCH_SCHEMA = "policy-epoch/1" as const;
export const POLICY_EPOCH_SIDECAR_SUFFIX = ".policy-epoch" as const;
export const POLICY_EPOCH_ENV_VAR = "MINDCODE_POLICY_EPOCH" as const;
export const POLICY_DIGEST_ENV_VAR = "MINDCODE_POLICY_DIGEST" as const;

export type PolicyJailbreakLevel = "disabled" | "lowered" | "full";

export interface PolicyEpochState {
  readonly schema_version: typeof POLICY_EPOCH_SCHEMA;
  readonly epoch: number;
  readonly digest: string;
  readonly jailbreak_level: PolicyJailbreakLevel;
  readonly updated_at: string;
}

export interface InheritedPolicyEpoch {
  readonly epoch: number;
  readonly digest: string;
}

export interface PolicySourceSection {
  readonly id: string;
  readonly content: string;
}

export type ResolvedPolicyEpoch = PolicyEpochState | InheritedPolicyEpoch;

export class PolicyEpochError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyEpochError";
  }
}

const JAILBREAK_LEVELS: readonly PolicyJailbreakLevel[] = [
  "disabled",
  "lowered",
  "full",
];
const MAX_DIGEST_LENGTH = 256;
export const POLICY_SOURCE_DIGEST_SCHEMA = "policy-source/1" as const;
const STATE_KEYS = [
  "schema_version",
  "epoch",
  "digest",
  "jailbreak_level",
  "updated_at",
] as const;

type StateRecord = Record<(typeof STATE_KEYS)[number], unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_DIGEST_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}

function isUpdatedAt(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 64 &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function isEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeSourceSection(
  section: PolicySourceSection,
  index: number,
): PolicySourceSection {
  if (
    typeof section !== "object" ||
    section === null ||
    typeof section.id !== "string" ||
    typeof section.content !== "string"
  ) {
    throw new PolicyEpochError(
      `invalid policy source section at index ${index}`,
    );
  }

  const id = section.id.replace(/\r\n?/g, "\n").trim();
  const content = section.content.replace(/\r\n?/g, "\n").trim();
  if (id.length === 0 || content.length === 0) {
    throw new PolicyEpochError(
      `policy source section at index ${index} must not be empty`,
    );
  }
  return Object.freeze({ id, content });
}

/**
 * Computes the session policy identity. This deliberately contains only
 * static Leader/Worker policy sections and the validated jailbreak level.
 * Target, task text, and the compiled epoch are not part of this digest.
 */
export function computePolicySourceDigest(
  sections: readonly PolicySourceSection[],
  jailbreakLevel: PolicyJailbreakLevel,
): string {
  if (!JAILBREAK_LEVELS.includes(jailbreakLevel)) {
    throw new PolicyEpochError("invalid jailbreak level");
  }

  const normalizedSections = sections.map(normalizeSourceSection);
  const canonical = JSON.stringify({
    schema: POLICY_SOURCE_DIGEST_SCHEMA,
    jailbreak_level: jailbreakLevel,
    sections: normalizedSections,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function freezeState(value: StateRecord): PolicyEpochState {
  return Object.freeze({
    schema_version: value.schema_version as typeof POLICY_EPOCH_SCHEMA,
    epoch: value.epoch as number,
    digest: value.digest as string,
    jailbreak_level: value.jailbreak_level as PolicyJailbreakLevel,
    updated_at: value.updated_at as string,
  });
}

/** Strictly validates and freezes a persisted policy epoch state. */
export function parsePolicyEpochState(
  value: unknown,
): PolicyEpochState | undefined {
  if (!isRecord(value)) return undefined;

  const keys = Object.keys(value).sort();
  const expectedKeys = [...STATE_KEYS].sort();
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key, index) => key !== expectedKeys[index])
  ) {
    return undefined;
  }

  if (
    value.schema_version !== POLICY_EPOCH_SCHEMA ||
    !isEpoch(value.epoch) ||
    !isDigest(value.digest) ||
    !JAILBREAK_LEVELS.includes(value.jailbreak_level as PolicyJailbreakLevel) ||
    !isUpdatedAt(value.updated_at)
  ) {
    return undefined;
  }

  return freezeState(value as StateRecord);
}

function statePath(): string {
  return getCurrentSessionSidecarPath(POLICY_EPOCH_SIDECAR_SUFFIX);
}

function parseJsonState(contents: string): PolicyEpochState | undefined {
  try {
    return parsePolicyEpochState(JSON.parse(contents) as unknown);
  } catch {
    return undefined;
  }
}

function readStoredStateOrMissing(path: string): PolicyEpochState | undefined {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new PolicyEpochError(
      `could not read policy epoch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = parseJsonState(contents);
  if (state === undefined) {
    throw new PolicyEpochError("could not parse policy epoch state");
  }
  return state;
}

/** Reads the current session state without replacing malformed or unreadable data. */
export function readCurrentPolicyEpochState(): PolicyEpochState | undefined {
  try {
    return parseJsonState(readFileSync(statePath(), "utf8"));
  } catch {
    return undefined;
  }
}

export const readPolicyEpochState = readCurrentPolicyEpochState;
export const getCurrentPolicyEpochState = readCurrentPolicyEpochState;

function parseInheritedEpoch(value: string): number | undefined {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) return undefined;
  const epoch = Number(value);
  return isEpoch(epoch) ? epoch : undefined;
}

/**
 * Parses the exact pair forwarded to a worker process. A partially specified or
 * malformed pair is rejected rather than being partially inherited.
 */
export function parsePolicyEpochEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): InheritedPolicyEpoch | undefined {
  const epochValue = environment[POLICY_EPOCH_ENV_VAR];
  const digestValue = environment[POLICY_DIGEST_ENV_VAR];
  if (epochValue === undefined && digestValue === undefined) return undefined;
  if (
    epochValue === undefined ||
    digestValue === undefined ||
    !isDigest(digestValue)
  ) {
    return undefined;
  }

  const epoch = parseInheritedEpoch(epochValue);
  if (epoch === undefined) return undefined;
  return Object.freeze({ epoch, digest: digestValue });
}

export const readInheritedPolicyEpoch = parsePolicyEpochEnvironment;
export const getPolicyEpochFromEnvironment = parsePolicyEpochEnvironment;

export const parseInheritedPolicyEpoch = parsePolicyEpochEnvironment;

function nextTimestamp(previous: string | undefined): string {
  const now = Date.now();
  const previousTime =
    previous === undefined ? Number.NaN : Date.parse(previous);
  const timestamp = Number.isFinite(previousTime)
    ? Math.max(now, previousTime + 1)
    : now;
  return new Date(timestamp).toISOString();
}

function writeStateAtomically(path: string, state: PolicyEpochState): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);

  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    const contents = `${JSON.stringify(state)}\n`;
    writeSync(descriptor, contents, undefined, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // Preserve the original persistence failure.
      }
    }
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new PolicyEpochError(
      `could not persist policy epoch: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function normalizeRegistration(
  digestOrInput:
    | string
    | { digest: string; jailbreak_level: PolicyJailbreakLevel },
  jailbreakLevel?: PolicyJailbreakLevel,
): { digest: string; jailbreak_level: PolicyJailbreakLevel } {
  const digest =
    typeof digestOrInput === "string" ? digestOrInput : digestOrInput.digest;
  const level =
    typeof digestOrInput === "string"
      ? jailbreakLevel
      : digestOrInput.jailbreak_level;

  if (!isDigest(digest)) throw new PolicyEpochError("invalid policy digest");
  if (!JAILBREAK_LEVELS.includes(level as PolicyJailbreakLevel)) {
    throw new PolicyEpochError("invalid jailbreak level");
  }
  return { digest, jailbreak_level: level as PolicyJailbreakLevel };
}

/**
 * Registers a compiled policy digest for the current session. Registration is
 * synchronous so Promise.all callers in one process cannot observe a torn
 * read/modify/write sequence.
 */
export function registerCompiledPolicyDigest(
  digestOrInput:
    | string
    | { digest: string; jailbreak_level: PolicyJailbreakLevel },
  jailbreakLevel?: PolicyJailbreakLevel,
): PolicyEpochState {
  const next = normalizeRegistration(digestOrInput, jailbreakLevel);
  const path = statePath();
  const current = readStoredStateOrMissing(path);

  if (
    current !== undefined &&
    current.digest === next.digest &&
    current.jailbreak_level === next.jailbreak_level
  ) {
    return current;
  }

  const epoch = current === undefined ? 0 : current.epoch + 1;
  if (!isEpoch(epoch)) {
    throw new PolicyEpochError("policy epoch exhausted");
  }

  const state = freezeState({
    schema_version: POLICY_EPOCH_SCHEMA,
    epoch,
    digest: next.digest,
    jailbreak_level: next.jailbreak_level,
    updated_at: nextTimestamp(current?.updated_at),
  });

  writeStateAtomically(path, state);
  return state;
}

export const registerPolicyDigest = registerCompiledPolicyDigest;

/**
 * Resolves the epoch for a policy source. Leaders register the source in the
 * current session; workers inherit an immutable epoch and must prove that
 * their local source digest is identical before compiling any policy.
 */
export function resolvePolicyEpochForSource(
  sourceDigest: string,
  jailbreakLevel: PolicyJailbreakLevel,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedPolicyEpoch {
  if (!isDigest(sourceDigest)) {
    throw new PolicyEpochError("invalid policy source digest");
  }
  if (!JAILBREAK_LEVELS.includes(jailbreakLevel)) {
    throw new PolicyEpochError("invalid jailbreak level");
  }

  const hasInheritedState =
    environment[POLICY_EPOCH_ENV_VAR] !== undefined ||
    environment[POLICY_DIGEST_ENV_VAR] !== undefined;
  if (hasInheritedState) {
    const inherited = parsePolicyEpochEnvironment(environment);
    if (inherited === undefined) {
      throw new PolicyEpochError("malformed inherited policy epoch");
    }
    if (inherited.digest !== sourceDigest) {
      throw new PolicyEpochError("inherited policy digest mismatch");
    }
    return inherited;
  }

  return registerCompiledPolicyDigest(sourceDigest, jailbreakLevel);
}
