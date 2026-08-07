/**
 * Provider-neutral rate-limit message generation for the VEXZY transport.
 */

import { formatResetTime } from "../utils/format.js";
import type { VexzyLimits } from "./vexzyLimits.js";

export const RATE_LIMIT_ERROR_PREFIXES = [
  "You've hit your",
  "You've used",
  "You're close to",
] as const;

export function isRateLimitErrorMessage(text: string): boolean {
  return RATE_LIMIT_ERROR_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export type RateLimitMessage = {
  message: string;
  severity: "error" | "warning";
};

export function getRateLimitMessage(
  limits: VexzyLimits,
  model: string,
): RateLimitMessage | null {
  if (limits.status === "rejected") {
    return { message: getLimitReachedText(limits, model), severity: "error" };
  }

  if (limits.status === "allowed_warning") {
    const warningThreshold = 0.7;
    if (
      limits.utilization !== undefined &&
      limits.utilization < warningThreshold
    ) {
      return null;
    }

    const text = getEarlyWarningText(limits);
    if (text) {
      return { message: text, severity: "warning" };
    }
  }

  return null;
}

export function getRateLimitErrorMessage(
  limits: VexzyLimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model);
  return message?.severity === "error" ? message.message : null;
}

export function getRateLimitWarning(
  limits: VexzyLimits,
  model: string,
): string | null {
  const message = getRateLimitMessage(limits, model);
  return message?.severity === "warning" ? message.message : null;
}

function getLimitReachedText(limits: VexzyLimits, model: string): string {
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined;
  const resetMessage = resetTime ? ` · resets ${resetTime}` : "";

  if (limits.rateLimitType === "seven_day_sonnet") {
    return formatLimitReachedText("Sonnet limit", resetMessage, model);
  }
  if (limits.rateLimitType === "seven_day_opus") {
    return formatLimitReachedText("Opus limit", resetMessage, model);
  }
  if (limits.rateLimitType === "seven_day") {
    return formatLimitReachedText("weekly limit", resetMessage, model);
  }
  if (limits.rateLimitType === "five_hour") {
    return formatLimitReachedText("session limit", resetMessage, model);
  }
  return formatLimitReachedText("usage limit", resetMessage, model);
}

function getEarlyWarningText(limits: VexzyLimits): string | null {
  let limitName: string | null;
  switch (limits.rateLimitType) {
    case "seven_day":
      limitName = "weekly limit";
      break;
    case "five_hour":
      limitName = "session limit";
      break;
    case "seven_day_opus":
      limitName = "Opus limit";
      break;
    case "seven_day_sonnet":
      limitName = "Sonnet limit";
      break;
    default:
      return null;
  }

  const used =
    limits.utilization === undefined
      ? undefined
      : Math.floor(limits.utilization * 100);
  const resetTime = limits.resetsAt
    ? formatResetTime(limits.resetsAt, true)
    : undefined;

  if (used !== undefined && used > 0) {
    const suffix = resetTime ? ` · resets ${resetTime}` : "";
    return `You've used ${used}% of your ${limitName}${suffix}`;
  }
  return resetTime
    ? `Approaching ${limitName} · resets ${resetTime}`
    : `Approaching ${limitName}`;
}

function formatLimitReachedText(
  limit: string,
  resetMessage: string,
  _model: string,
): string {
  return `You've hit your ${limit}${resetMessage}`;
}
