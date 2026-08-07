import { getAuthTokenSource } from "./auth.js";
import { isEnvTruthy } from "./envUtils.js";

/**
 * Cost reporting is local to the active VEXZY session. Authentication only
 * determines whether the local usage panel should be shown; no plan,
 * plan-tier or provider billing state is consulted.
 */
export function hasConsoleBillingAccess(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false;
  }

  return getAuthTokenSource().hasToken;
}
