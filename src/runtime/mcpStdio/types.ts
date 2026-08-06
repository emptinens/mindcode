import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export const MCP_STDIO_MAX_CONNECTION_ID_LENGTH = 128;
export const MCP_STDIO_MAX_COMMAND_LENGTH = 4_096;
export const MCP_STDIO_MAX_ARGUMENTS = 128;
export const MCP_STDIO_MAX_ARGUMENT_LENGTH = 8_192;
export const MCP_STDIO_MAX_CWD_LENGTH = 4_096;
export const MCP_STDIO_MAX_ENV_VARS = 128;
export const MCP_STDIO_MAX_ENV_KEY_LENGTH = 256;
export const MCP_STDIO_MAX_ENV_VALUE_LENGTH = 32_768;
export const MCP_STDIO_MAX_ENV_BYTES = 1024 * 1024;
export const MCP_STDIO_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS = 120_000;
export const MCP_STDIO_MAX_QUEUE_BYTES = 32 * 1024 * 1024;
export const MCP_STDIO_MAX_QUEUE_MESSAGES = 128;
export const MCP_STDIO_MAX_PID = 2 ** 31 - 1;

export type McpStdioServerParameters = {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
};

export type McpStdioOpenParams = {
  connection_id: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
};

export type McpStdioOpenResult = {
  connection_id: string;
  pid: number;
};

export type McpStdioSendParams = {
  connection_id: string;
  message: JSONRPCMessage;
};

export type McpStdioSendResult = {
  accepted: true;
};

export type McpStdioReceiveParams = {
  connection_id: string;
  timeout_ms?: number;
};

export type McpStdioReceiveResult = {
  message: JSONRPCMessage | null;
  closed: boolean;
};

export type McpStdioCloseParams = {
  connection_id: string;
};

export type McpStdioCloseResult = {
  closed: boolean;
};

export type McpStdioConnectionState = "running" | "closed" | "failed";

export type McpStdioStatusConnection = {
  connection_id: string;
  pid: number;
  state: McpStdioConnectionState;
  queued_messages: number;
  queued_bytes: number;
  stderr_bytes: number;
};

export type McpStdioStatusParams = {
  connection_id?: string;
};

export type McpStdioStatusResult = {
  connections: McpStdioStatusConnection[];
};

export type McpStdioRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  onDispatch?: () => void;
};

export interface McpStdioRpc {
  open(
    params: McpStdioOpenParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioOpenResult>;
  send(
    params: McpStdioSendParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioSendResult>;
  receive(
    params: McpStdioReceiveParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioReceiveResult>;
  close(
    params: McpStdioCloseParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioCloseResult>;
  status(
    params: McpStdioStatusParams,
    options?: McpStdioRequestOptions,
  ): Promise<McpStdioStatusResult>;
}
