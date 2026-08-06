import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { SessionIndexProtocolError } from "./errors.js";

export const SESSION_INDEX_METHODS = [
  "session_index.upsert",
  "session_index.get",
  "session_index.list",
  "session_index.search",
  "session_index.remove",
] as const;

export const SESSION_INDEX_LIMIT = 1_000;
export const SESSION_ID_MAX_LENGTH = 256;
export const PROJECT_PATH_MAX_LENGTH = 4_096;
export const TRANSCRIPT_PATH_MAX_LENGTH = 4_096;
export const TITLE_MAX_LENGTH = 4_096;
export const FIRST_PROMPT_MAX_LENGTH = 16_384;
export const SEARCH_QUERY_MAX_LENGTH = 4_096;

export type SessionIndexRequestOptions = DaemonRequestOptions;

export type SessionIndexRecord = {
  session_id: string;
  project_path: string;
  transcript_path: string;
  modified_at_ms: number;
  size_bytes: number;
  title?: string;
  first_prompt?: string;
};

export type SessionIndexUpsertParams = SessionIndexRecord;

export type SessionIndexGetParams = {
  session_id: string;
};

export type SessionIndexListParams = {
  project_path?: string;
  limit?: number;
  before_modified_at_ms?: number;
};

export type SessionIndexSearchParams = {
  query: string;
  project_path?: string;
  limit?: number;
  before_modified_at_ms?: number;
};

export type SessionIndexRemoveParams = {
  session_id: string;
};

export type SessionIndexResponse = {
  upsert: { session: SessionIndexRecord };
  get: { session: SessionIndexRecord | null };
  list: { sessions: SessionIndexRecord[] };
  search: { sessions: SessionIndexRecord[] };
  remove: { removed: boolean };
};

export type SessionIndexDaemonTransport = {
  request?: <T>(
    method: string,
    params?: unknown,
    options?: DaemonRequestOptions,
  ) => Promise<T>;
  requestWithFallback?: <T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options?: DaemonRequestOptions,
  ) => Promise<DaemonCallResult<T>>;
};

export function validateSessionRecord(
  value: unknown,
  context = "session",
): SessionIndexRecord {
  const object = exact(
    value,
    [
      "session_id",
      "project_path",
      "transcript_path",
      "modified_at_ms",
      "size_bytes",
      "title",
      "first_prompt",
    ],
    context,
  );
  const session: SessionIndexRecord = {
    session_id: boundedText(
      required(object, "session_id", context),
      `${context}.session_id`,
      SESSION_ID_MAX_LENGTH,
      false,
    ),
    project_path: boundedText(
      required(object, "project_path", context),
      `${context}.project_path`,
      PROJECT_PATH_MAX_LENGTH,
      false,
    ),
    transcript_path: boundedText(
      required(object, "transcript_path", context),
      `${context}.transcript_path`,
      TRANSCRIPT_PATH_MAX_LENGTH,
      false,
    ),
    modified_at_ms: nonNegativeSafeInteger(
      required(object, "modified_at_ms", context),
      `${context}.modified_at_ms`,
    ),
    size_bytes: nonNegativeSafeInteger(
      required(object, "size_bytes", context),
      `${context}.size_bytes`,
    ),
  };
  if (has(object, "title")) {
    session.title = boundedText(
      object.title,
      `${context}.title`,
      TITLE_MAX_LENGTH,
      true,
    );
  }
  if (has(object, "first_prompt")) {
    session.first_prompt = boundedText(
      object.first_prompt,
      `${context}.first_prompt`,
      FIRST_PROMPT_MAX_LENGTH,
      true,
    );
  }
  return session;
}

export function validateSessionId(
  value: unknown,
  context = "session_id",
): string {
  return boundedText(value, context, SESSION_ID_MAX_LENGTH, false);
}

export function validateGetParams(
  value: unknown,
  context = "get params",
): SessionIndexGetParams {
  const object = exact(value, ["session_id"], context);
  return {
    session_id: validateSessionId(
      required(object, "session_id", context),
      `${context}.session_id`,
    ),
  };
}

export function validateListParams(
  value: unknown,
  context = "list params",
): SessionIndexListParams {
  const object = exact(
    value,
    ["project_path", "limit", "before_modified_at_ms"],
    context,
  );
  const params: SessionIndexListParams = {};
  if (has(object, "project_path")) {
    params.project_path = boundedText(
      object.project_path,
      `${context}.project_path`,
      PROJECT_PATH_MAX_LENGTH,
      false,
    );
  }
  addPaging(params, object, context);
  return params;
}

export function validateSearchParams(
  value: unknown,
  context = "search params",
): SessionIndexSearchParams {
  const object = exact(
    value,
    ["query", "project_path", "limit", "before_modified_at_ms"],
    context,
  );
  const params: SessionIndexSearchParams = {
    query: boundedText(
      required(object, "query", context),
      `${context}.query`,
      SEARCH_QUERY_MAX_LENGTH,
      false,
      true,
    ),
  };
  if (has(object, "project_path")) {
    params.project_path = boundedText(
      object.project_path,
      `${context}.project_path`,
      PROJECT_PATH_MAX_LENGTH,
      false,
    );
  }
  addPaging(params, object, context);
  return params;
}

export function validateRemoveParams(
  value: unknown,
  context = "remove params",
): SessionIndexRemoveParams {
  return validateGetParams(value, context);
}

export function validateUpsertResult(
  value: unknown,
): SessionIndexResponse["upsert"] {
  const object = exact(value, ["session"], "upsert result");
  return {
    session: validateWireSessionRecord(
      required(object, "session", "upsert result"),
      "upsert result.session",
    ),
  };
}

export function validateGetResult(value: unknown): SessionIndexResponse["get"] {
  const object = exact(value, ["session"], "get result");
  const session = required(object, "session", "get result");
  return {
    session:
      session === null
        ? null
        : validateWireSessionRecord(session, "get result.session"),
  };
}

export function validateListResult(
  value: unknown,
  context = "list result",
): { sessions: SessionIndexRecord[] } {
  const object = exact(value, ["sessions"], context);
  const sessions = required(object, "sessions", context);
  if (!Array.isArray(sessions))
    throw new SessionIndexProtocolError(`${context}.sessions must be an array`);
  return {
    sessions: sessions.map((session, index) =>
      validateWireSessionRecord(session, `${context}.sessions[${index}]`),
    ),
  };
}

export const validateSearchResult = (value: unknown) =>
  validateListResult(value, "search result");

export function validateRemoveResult(
  value: unknown,
): SessionIndexResponse["remove"] {
  const object = exact(value, ["removed"], "remove result");
  return {
    removed: booleanValue(
      required(object, "removed", "remove result"),
      "remove result.removed",
    ),
  };
}

function addPaging(
  params: SessionIndexListParams | SessionIndexSearchParams,
  object: Record<string, unknown>,
  context: string,
): void {
  if (has(object, "limit")) {
    params.limit = boundedLimit(object.limit, `${context}.limit`);
  }
  if (has(object, "before_modified_at_ms")) {
    params.before_modified_at_ms = nonNegativeSafeInteger(
      object.before_modified_at_ms,
      `${context}.before_modified_at_ms`,
    );
  }
}
function boundedLimit(value: unknown, context: string): number {
  const result = nonNegativeSafeInteger(value, context);
  if (result > SESSION_INDEX_LIMIT) {
    throw new TypeError(
      `${context} must be an integer from 0 to ${SESSION_INDEX_LIMIT}`,
    );
  }
  return result;
}

function nonNegativeSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer`);
  }
  return value as number;
}

function boundedText(
  value: unknown,
  context: string,
  maxLength: number,
  allowEmpty: boolean,
  allowNewlines = false,
): string {
  if (typeof value !== "string")
    throw new TypeError(`${context} must be a string`);
  if (!allowEmpty && value.length === 0)
    throw new TypeError(`${context} must not be empty`);
  if (new TextEncoder().encode(value).byteLength > maxLength)
    throw new TypeError(`${context} exceeds the maximum length`);
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    const allowedNewline =
      allowNewlines &&
      (codePoint === 9 || codePoint === 10 || codePoint === 13);
    if (
      codePoint === 0 ||
      codePoint === 127 ||
      (codePoint < 32 && !allowedNewline)
    ) {
      throw new TypeError(`${context} contains forbidden control characters`);
    }
  }
  return value;
}

function validateWireSessionRecord(
  value: unknown,
  context: string,
): SessionIndexRecord {
  try {
    return validateSessionRecord(value, context);
  } catch (error) {
    if (error instanceof SessionIndexProtocolError) throw error;
    throw new SessionIndexProtocolError(
      error instanceof Error ? error.message : `${context} is invalid`,
      error,
    );
  }
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionIndexProtocolError(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: unknown,
  keys: readonly string[],
  context: string,
): Record<string, unknown> {
  const object = record(value, context);
  const allowed = new Set(keys);
  for (const key of Object.keys(object)) {
    if (!allowed.has(key))
      throw new SessionIndexProtocolError(
        `${context} contains an unknown field`,
      );
  }
  return object;
}

function required(
  object: Record<string, unknown>,
  key: string,
  context: string,
): unknown {
  if (!has(object, key))
    throw new SessionIndexProtocolError(`${context}.${key} is required`);
  return object[key];
}

function has(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean")
    throw new SessionIndexProtocolError(`${context} must be a boolean`);
  return value;
}
