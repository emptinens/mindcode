import type { DaemonFallbackReason, DaemonTimeoutKind } from "./types.js";

export class DaemonClientError extends Error {
  readonly code: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "DaemonClientError";
    this.code = code;
    this.cause = cause;
  }
}

export class DaemonTimeoutError extends DaemonClientError {
  readonly kind: DaemonTimeoutKind;

  constructor(kind: DaemonTimeoutKind, timeoutMs: number) {
    super(
      `DAEMON_${kind.toUpperCase()}_TIMEOUT`,
      `Daemon ${kind} timed out after ${timeoutMs}ms`,
    );
    this.name = "DaemonTimeoutError";
    this.kind = kind;
  }
}

export class DaemonDisconnectedError extends DaemonClientError {
  constructor(cause?: unknown) {
    super("DAEMON_DISCONNECTED", "Daemon socket disconnected", cause);
    this.name = "DaemonDisconnectedError";
  }
}

export class DaemonDisabledError extends DaemonClientError {
  constructor() {
    super("DAEMON_DISABLED", "MindCode daemon is disabled");
    this.name = "DaemonDisabledError";
  }
}

export class DaemonCancelledError extends DaemonClientError {
  constructor() {
    super("DAEMON_CANCELLED", "Daemon request was cancelled");
    this.name = "DaemonCancelledError";
  }
}

export class DaemonRemoteError extends DaemonClientError {
  readonly remoteCode?: string;
  readonly details?: unknown;

  constructor(message: string, code?: string, details?: unknown) {
    super("DAEMON_REMOTE_ERROR", message);
    this.name = "DaemonRemoteError";
    this.remoteCode = code;
    this.details = details;
  }
}

export function classifyDaemonFallback(error: unknown): DaemonFallbackReason {
  if (error instanceof DaemonDisabledError) return "disabled";
  if (error instanceof DaemonTimeoutError) {
    return `${error.kind}_timeout`;
  }
  if (error instanceof DaemonCancelledError) return "cancelled";
  if (error instanceof DaemonRemoteError) return "remote_error";
  if (error instanceof Error && error.name === "DaemonProtocolError") {
    return "protocol_error";
  }
  return "unavailable";
}
