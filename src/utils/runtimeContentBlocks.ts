import type { ContentBlockParam } from "../services/api/vexzy/protocolTypes.js";

function isContentBlockLike(value: unknown): value is ContentBlockParam {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * Normalize content received from persisted sessions and compatibility
 * transports. Older/broken payloads can contain a single block instead of an
 * array; treating that shape as an empty array both loses data and lets array
 * operations crash later in the message pipeline.
 */
export function normalizeRuntimeContentBlocks(
  value: unknown,
): ContentBlockParam[] {
  if (Array.isArray(value)) {
    return value.filter(isContentBlockLike);
  }
  return isContentBlockLike(value) ? [value] : [];
}
