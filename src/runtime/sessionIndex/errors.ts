import { DaemonRemoteError } from "../daemon/errors.js";

export const SESSION_INDEX_PROTOCOL_ERROR =
  "SESSION_INDEX_PROTOCOL_ERROR" as const;
export const SESSION_INDEX_REMOTE_ERROR = "SESSION_INDEX_REMOTE_ERROR" as const;

export type SessionIndexRemoteCode =
  | "SESSION_NOT_FOUND"
  | "INVALID_SESSION"
  | "DUPLICATE_SESSION"
  | "DATABASE_CLOSED"
  | typeof SESSION_INDEX_PROTOCOL_ERROR
  | typeof SESSION_INDEX_REMOTE_ERROR;

export class SessionIndexDaemonError extends Error {
  readonly code: SessionIndexRemoteCode;
  readonly remoteCode?: string;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(
    code: SessionIndexRemoteCode,
    message: string,
    options: {
      remoteCode?: string;
      details?: unknown;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "SessionIndexDaemonError";
    this.code = code;
    this.remoteCode = options.remoteCode;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export class SessionIndexProtocolError extends SessionIndexDaemonError {
  constructor(message: string, cause?: unknown) {
    super(SESSION_INDEX_PROTOCOL_ERROR, message, { cause });
    this.name = "SessionIndexProtocolError";
  }
}

export class SessionIndexRemoteError extends SessionIndexDaemonError {
  constructor(
    message: string,
    remoteCode?: string,
    details?: unknown,
    cause?: unknown,
  ) {
    super(
      isStableRemoteCode(remoteCode) ? remoteCode : SESSION_INDEX_REMOTE_ERROR,
      message,
      { remoteCode, details, cause },
    );
    this.name = "SessionIndexRemoteError";
  }
}

export function normalizeSessionIndexError(error: unknown): unknown {
  if (error instanceof SessionIndexDaemonError) return error;
  if (error instanceof DaemonRemoteError) {
    return new SessionIndexRemoteError(
      error.message,
      error.remoteCode,
      error.details,
      error,
    );
  }
  return error;
}

function isStableRemoteCode(
  value: string | undefined,
): value is SessionIndexRemoteCode {
  return (
    value === "SESSION_NOT_FOUND" ||
    value === "INVALID_SESSION" ||
    value === "DUPLICATE_SESSION" ||
    value === "DATABASE_CLOSED"
  );
}
