import { InvalidTaskError } from "../graph/errors.js";

export type TargetSet = {
  files_touched: string[];
  read_set: string[];
  write_set: string[];
};

/**
 * Store target names in one portable, cwd-relative representation.  The
 * graph deliberately does not stat the targets: a task may create a file.
 */
export function normalizeTarget(value: string, field = "target"): string {
  if (typeof value !== "string") {
    throw new InvalidTaskError(`${field} must contain only strings`);
  }
  const raw = value.trim();
  if (raw.length === 0) {
    throw new InvalidTaskError(`${field} must not contain empty targets`);
  }
  if (raw.includes("\0")) {
    throw new InvalidTaskError(`${field} contains a NUL byte`);
  }

  const portable = raw.replaceAll("\\", "/");
  if (
    portable.startsWith("/") ||
    portable.startsWith("//") ||
    /^[A-Za-z]:\//.test(portable) ||
    portable.startsWith("~")
  ) {
    throw new InvalidTaskError(
      `${field} must be cwd-relative: ${JSON.stringify(value)}`,
    );
  }

  const parts = portable.split("/");
  if (parts.some((part) => part === "..")) {
    throw new InvalidTaskError(
      `${field} must not traverse outside the cwd: ${JSON.stringify(value)}`,
    );
  }

  const normalizedParts = parts.filter((part) => part !== ".");
  if (
    normalizedParts.length === 0 ||
    normalizedParts.some((part) => part.length === 0)
  ) {
    throw new InvalidTaskError(
      `${field} contains an ambiguous target: ${JSON.stringify(value)}`,
    );
  }
  return normalizedParts.join("/");
}

export function normalizeTargets(
  values: readonly string[] | undefined,
  field: string,
): string[] {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new InvalidTaskError(`${field} must be an array of strings`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeTarget(value, field);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

export function normalizeTargetSet(
  files_touched: readonly string[] | undefined,
  read_set: readonly string[] | undefined,
  write_set: readonly string[] | undefined,
): TargetSet & { explicit_sets: boolean } {
  return {
    files_touched: normalizeTargets(files_touched, "files_touched"),
    read_set: normalizeTargets(read_set, "read_set"),
    write_set: normalizeTargets(write_set, "write_set"),
    explicit_sets: read_set !== undefined || write_set !== undefined,
  };
}
