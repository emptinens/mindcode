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
  type PromptSectionInput,
  type PromptTarget,
  compilePromptPolicy,
} from "./promptCompiler.js";
import {
  getContentHandlingSection,
  getInjectionHandlingSection,
} from "./staticPolicy.js";

/**
 * The static source identity shared by every prompt boundary. Dynamic task
 * text and the compilation target are intentionally excluded so changing a
 * boundary does not advance the session policy epoch or fragment caches.
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

/**
 * Sections used by the Worker and resume system-prompt boundaries. Keep this
 * order stable: it is part of the prompt cache key and the golden contract.
 */
export function getWorkerPolicyPromptSections(
  jailbreakLevel: JailbreakLevel,
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
      content: getContentHandlingSection(jailbreakLevel),
    },
  ].filter((section) => section.content.length > 0);
}

export interface CompiledPromptBoundarySnapshot extends PromptPolicySnapshot {
  readonly sourceDigest: string;
}

export type CompiledWorkerPolicySnapshot = CompiledPromptBoundarySnapshot;

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

function resolvePromptBoundaryJailbreakLevel(
  requestedJailbreakLevel?: JailbreakLevel,
): JailbreakLevel {
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
  return (
    requestedJailbreakLevel ?? inheritedJailbreakLevel ?? getJailbreakLevel()
  );
}

function compileResolvedPromptBoundary(
  target: PromptTarget,
  sections: readonly PromptSectionInput[],
  jailbreakLevel: JailbreakLevel,
): CompiledPromptBoundarySnapshot {
  const sourceDigest = getWorkerPolicySourceDigest(jailbreakLevel);
  const resolvedEpoch = resolvePolicyEpochForSource(
    sourceDigest,
    jailbreakLevel,
  );
  const snapshot = compilePromptPolicy({
    target,
    sections,
    jailbreakLevel,
    policyEpoch: resolvedEpoch.epoch,
  });

  return Object.freeze({ ...snapshot, sourceDigest });
}

/**
 * Compiles one target boundary against the session policy identity. Callers
 * provide only the sections that belong at that boundary, which preserves
 * existing static/dynamic prompt cache boundaries.
 */
export function compilePromptBoundary(
  target: PromptTarget,
  sections: readonly PromptSectionInput[],
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledPromptBoundarySnapshot {
  const jailbreakLevel = resolvePromptBoundaryJailbreakLevel(
    requestedJailbreakLevel,
  );
  return compileResolvedPromptBoundary(target, sections, jailbreakLevel);
}

export function getCompiledLeaderPolicySnapshot(
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledPromptBoundarySnapshot {
  const jailbreakLevel = resolvePromptBoundaryJailbreakLevel(
    requestedJailbreakLevel,
  );
  return compileResolvedPromptBoundary(
    "leader",
    [
      {
        id: "leader-architecture",
        content: MINDCODE_LEADER_WORKER_ARCHITECTURE,
      },
    ],
    jailbreakLevel,
  );
}

export function getCompiledWorkerPolicySnapshot(
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledWorkerPolicySnapshot {
  const jailbreakLevel = resolvePromptBoundaryJailbreakLevel(
    requestedJailbreakLevel,
  );
  return compileResolvedPromptBoundary(
    "worker",
    getWorkerPolicyPromptSections(jailbreakLevel),
    jailbreakLevel,
  );
}

export function getCompiledCompactPolicySnapshot(
  compactSystemPrompt: string,
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledPromptBoundarySnapshot {
  const jailbreakLevel = resolvePromptBoundaryJailbreakLevel(
    requestedJailbreakLevel,
  );
  return compileResolvedPromptBoundary(
    "compact",
    [{ id: "compact-system", content: compactSystemPrompt }],
    jailbreakLevel,
  );
}

export function getCompiledResumePolicySnapshot(
  requestedJailbreakLevel?: JailbreakLevel,
): CompiledPromptBoundarySnapshot {
  const jailbreakLevel = resolvePromptBoundaryJailbreakLevel(
    requestedJailbreakLevel,
  );
  return compileResolvedPromptBoundary(
    "resume",
    getWorkerPolicyPromptSections(jailbreakLevel),
    jailbreakLevel,
  );
}
