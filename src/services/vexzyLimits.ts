import isEqual from "lodash-es/isEqual.js";
import { logEvent } from "./analytics/index.js";
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from "./analytics/index.js";
import type { APIError } from "./api/vexzy/errors.js";

/** Status reported by the VEXZY request lifecycle. */
type QuotaStatus = "allowed" | "allowed_warning" | "rejected";

/** Optional logical window used by compatible SDK consumers. */
type RateLimitType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet";

export type { RateLimitType };

export type VexzyLimits = {
  status: QuotaStatus;
  resetsAt?: number;
  rateLimitType?: RateLimitType;
  utilization?: number;
};

type RawUtilization = {
  five_hour?: { utilization: number; resets_at: number };
  seven_day?: { utilization: number; resets_at: number };
};

/** VEXZY reports usage through response tokens and credit accounting. */
export function getRawUtilization(): RawUtilization {
  return {};
}

export let currentLimits: VexzyLimits = { status: "allowed" };

type StatusChangeListener = (limits: VexzyLimits) => void;
export const statusListeners: Set<StatusChangeListener> = new Set();

export function emitStatusChange(limits: VexzyLimits): void {
  currentLimits = limits;
  for (const listener of statusListeners) listener(limits);
  logEvent("tengu_vexzy_rate_limit_status_changed", {
    status:
      limits.status as AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS,
  });
}

export function resetRateLimits(): void {
  const defaults: VexzyLimits = { status: "allowed" };
  if (!isEqual(currentLimits, defaults)) {
    emitStatusChange(defaults);
  } else {
    currentLimits = defaults;
  }
}

/**
 * A successful VEXZY response clears a transient rejected state. VEXZY usage
 * is accounted from response usage tokens and catalog pricing, not provider
 * quota headers.
 */
export function extractQuotaStatusFromHeaders(
  _headers: globalThis.Headers,
): void {
  resetRateLimits();
}

/** Mark a transient request-limit response for prompt-suggestion consumers. */
export function extractQuotaStatusFromError(error: APIError): void {
  if (error.status !== 429) return;
  const retryAfter = error.headers?.get("retry-after");
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const resetsAt = Number.isFinite(seconds)
    ? Math.floor(Date.now() / 1000) + Math.max(0, seconds)
    : undefined;
  const next: VexzyLimits = {
    status: "rejected",
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
  if (!isEqual(currentLimits, next)) {
    emitStatusChange(next);
  }
}

export {
  getRateLimitErrorMessage,
  getRateLimitWarning,
} from "./rateLimitMessages.js";
