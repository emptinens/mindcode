export {
  getCompiledWorkerPolicySnapshot,
  getWorkerPolicyPromptSections,
  getWorkerPolicySourceDigest,
  getWorkerPolicySourceSections,
} from "./promptBoundary.js";
import {
  assertWorkerPolicyIdentity,
  type WorkerPolicyIdentity,
} from "./policyEpoch.js";
import {
  getCompiledWorkerPolicySnapshot,
  type CompiledWorkerPolicySnapshot,
} from "./promptBoundary.js";
export type {
  CompiledWorkerPolicySnapshot,
} from "./promptBoundary.js";

export type { WorkerPolicyIdentity } from "./policyEpoch.js";

/** Returns the immutable identity used by every Worker execution boundary. */
export function getWorkerPolicyIdentity(
  snapshot: CompiledWorkerPolicySnapshot = getCompiledWorkerPolicySnapshot(),
): WorkerPolicyIdentity {
  return assertWorkerPolicyIdentity({
    policyEpoch: snapshot.policyEpoch,
    policyDigest: snapshot.sourceDigest,
  });
}
