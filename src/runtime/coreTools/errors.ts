export const CORE_TOOLS_PROTOCOL_ERROR = "CORE_TOOLS_PROTOCOL_ERROR" as const;

export class CoreToolsProtocolError extends Error {
  readonly code = CORE_TOOLS_PROTOCOL_ERROR;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CoreToolsProtocolError";
  }
}
