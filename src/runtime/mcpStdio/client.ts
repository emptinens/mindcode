import { type DaemonManager, getDaemonManager } from "../daemon/manager.js";
import type {
  DaemonCallResult,
  DaemonManagerRequestOptions,
} from "../daemon/types.js";
import type {
  McpStdioCloseParams,
  McpStdioCloseResult,
  McpStdioOpenParams,
  McpStdioOpenResult,
  McpStdioReceiveParams,
  McpStdioReceiveResult,
  McpStdioRequestOptions,
  McpStdioRpc,
  McpStdioSendParams,
  McpStdioSendResult,
  McpStdioStatusParams,
  McpStdioStatusResult,
} from "./types.js";
import {
  validateCloseParams,
  validateCloseResult,
  validateOpenParams,
  validateOpenResult,
  validateReceiveParams,
  validateReceiveResult,
  validateSendParams,
  validateSendResult,
  validateStatusParams,
  validateStatusResult,
} from "./validation.js";

export type McpStdioDaemonManager = Pick<DaemonManager, "requestWithFallback">;

export class McpStdioDaemonError extends Error {
  readonly code = "MCP_STDIO_DAEMON_UNAVAILABLE";

  constructor(message = "MindCode daemon is unavailable", cause?: unknown) {
    super(message, { cause });
    this.name = "McpStdioDaemonError";
  }
}

const NO_FALLBACK = Symbol("mcp-stdio-no-fallback");

export class DaemonMcpStdioRpc implements McpStdioRpc {
  private readonly manager: McpStdioDaemonManager;

  constructor(manager: McpStdioDaemonManager = getDaemonManager()) {
    this.manager = manager;
  }

  async open(
    params: McpStdioOpenParams,
    options: McpStdioRequestOptions = {},
  ): Promise<McpStdioOpenResult> {
    const validated = validateOpenParams(params);
    const result = await this.request<McpStdioOpenResult>(
      "mcp.stdio.open",
      validated,
      options,
    );
    return validateOpenResult(result);
  }

  async send(
    params: McpStdioSendParams,
    options: McpStdioRequestOptions = {},
  ): Promise<McpStdioSendResult> {
    const validated = validateSendParams(params);
    const result = await this.request<McpStdioSendResult>(
      "mcp.stdio.send",
      validated,
      options,
    );
    return validateSendResult(result);
  }

  async receive(
    params: McpStdioReceiveParams,
    options: McpStdioRequestOptions = {},
  ): Promise<McpStdioReceiveResult> {
    const validated = validateReceiveParams(params);
    const result = await this.request<McpStdioReceiveResult>(
      "mcp.stdio.receive",
      validated,
      options,
    );
    return validateReceiveResult(result);
  }

  async close(
    params: McpStdioCloseParams,
    options: McpStdioRequestOptions = {},
  ): Promise<McpStdioCloseResult> {
    const validated = validateCloseParams(params);
    const result = await this.request<McpStdioCloseResult>(
      "mcp.stdio.close",
      validated,
      options,
    );
    return validateCloseResult(result);
  }

  async status(
    params: McpStdioStatusParams,
    options: McpStdioRequestOptions = {},
  ): Promise<McpStdioStatusResult> {
    const validated = validateStatusParams(params);
    const result = await this.request<McpStdioStatusResult>(
      "mcp.stdio.status",
      validated,
      options,
    );
    return validateStatusResult(result);
  }

  private async request<T>(
    method: string,
    params: unknown,
    options: McpStdioRequestOptions,
  ): Promise<T> {
    const requestOptions: DaemonManagerRequestOptions = {
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
      ...(options.onDispatch === undefined
        ? {}
        : { onDispatch: options.onDispatch }),
    };
    const result: DaemonCallResult<T | typeof NO_FALLBACK> =
      await this.manager.requestWithFallback<T | typeof NO_FALLBACK>(
        method,
        params,
        NO_FALLBACK,
        requestOptions,
      );
    if (result.source === "fallback") {
      if (result.error instanceof Error) throw result.error;
      throw new McpStdioDaemonError(
        `Daemon request ${method} failed`,
        result.error,
      );
    }
    return result.value as T;
  }
}
