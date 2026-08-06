export type StreamingDagErrorCode =
  | "INVALID_SNAPSHOT"
  | "INVALID_EVENT"
  | "NOT_READY"
  | "RESYNC_REQUIRED"
  | "LEADER_DISCONNECTED"
  | "CANCELLED"
  | "TASK_NOT_FOUND";

export class StreamingDagError extends Error {
  readonly code: StreamingDagErrorCode;
  override readonly cause?: unknown;

  constructor(code: StreamingDagErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "StreamingDagError";
    this.code = code;
    this.cause = cause;
  }
}
