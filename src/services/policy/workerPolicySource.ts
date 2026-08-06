import {
  MINDCODE_LEADER_WORKER_ARCHITECTURE,
  MINDCODE_WORKER_PROMPT,
} from "../../constants/prompts/mindcodeArchitecture.js";
import type { JailbreakLevel } from "../../utils/jailbreak.js";
import {
  JAILBREAK_LEVEL_ENV_VAR,
  getJailbreakLevel,
  getJailbreakLevelFromEnvironment,
} from "../../utils/jailbreak.js";
import {
  PolicyEpochError,
  type PolicySourceSection,
  computePolicySourceDigest,
  resolvePolicyEpochForSource,
} from "./policyEpoch.js";
import {
  type PromptPolicySnapshot,
  compilePromptPolicy,
} from "./promptCompiler.js";
import {
  getContentHandlingSection,
  getInjectionHandlingSection,
} from "./staticPolicy.js";

/**
 * The only inputs to the session policy identity. Dynamic task text and the
 * prompt target are intentionally absent so target compilation does not churn
 * the policy epoch.
 */
export function getWorkerPolicySourceSections(
  jailbreakLevel: JailbreakLevel,
): readonly PolicySourceSection[] {
  return [
    {
      id: "leader-worker-architecture",
      content: MINDCODE_LEADER_WORKER_ARCHITECTURE,
    },
    {
      id: "worker-contract",
      content: MINDCODE_WORKER_PROMPT,
    },
    {
      id: "injection-handling",
      content: getInjectionHandlingSection(),
    },
    {
      id: "content-handling",
      content: getContentHandlingSection(jailbreakLevel),
    },
  ].filter((section) => section.content.length > 0);
}

export function getWorkerPolicySourceDigest(
  jailbreakLevel: JailbreakLevel = getValidatedPolicyJailbreakLevel(),
): string {
  return computePolicySourceDigest(
    getWorkerPolicySourceSections(jailbreakLevel),
    jailbreakLevel,
  );
}

export interface CompiledWorkerPolicySnapshot extends PromptPolicySnapshot {
  readonly sourceDigest: string;
}

function getValidatedPolicyJailbreakLevel(): JailbreakLevel {
  const rawLevel = process.env[JAILBREAK_LEVEL_ENV_VAR];
  if (rawLevel !== undefined) {
    const inheritedLevel = getJailbreakLevelFromEnvironment();
    if (inheritedLevel === undefined) {
      throw new PolicyEpochError("malformed inherited jailbreak level");
    }
    return inheritedLevel;
  }
  return getJailbreakLevel();
}

function getWorkerPolicySections(
  level: JailbreakLevel,
): readonly PolicySourceSection[] {
  return [
    {
      id: "worker-contract",
      content: MINDCODE_WORKER_PROMPT,
    },
    {
      id: "injection-handling",
      content: getInjectionHandlingSection(),
    },
    {
      id: "content-handling",
      content: getContentHandlingSection(level),
    },
  ].filter((section) => section.content.length > 0);
}

export function getCompiledWorkerPolicySnapshot(
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledWorkerPolicySnapshot {
  const inheritedJailbreakLevel =
    process.env[JAILBREAK_LEVEL_ENV_VAR] === undefined
      ? undefined
      : getValidatedPolicyJailbreakLevel();
  if (
    requestedJailbreakLevel !== undefined &&
    inheritedJailbreakLevel !== undefined &&
    requestedJailbreakLevel !== inheritedJailbreakLevel
  ) {
    throw new PolicyEpochError("inherited jailbreak level mismatch");
  }
  const jailbreakLevel =
    requestedJailbreakLevel ?? inheritedJailbreakLevel ?? getJailbreakLevel();
  const sourceDigest = getWorkerPolicySourceDigest(jailbreakLevel);
  const resolvedEpoch = resolvePolicyEpochForSource(
    sourceDigest,
    jailbreakLevel,
  );
  const snapshot = compilePromptPolicy({
    target: "worker",
    sections: getWorkerPolicySections(jailbreakLevel),
    jailbreakLevel,
    policyEpoch: resolvedEpoch.epoch,
  });

  return Object.freeze({ ...snapshot, sourceDigest });
}
