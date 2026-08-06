import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import {
  MCP_STDIO_MAX_ARGUMENTS,
  MCP_STDIO_MAX_ARGUMENT_LENGTH,
  MCP_STDIO_MAX_COMMAND_LENGTH,
  MCP_STDIO_MAX_CONNECTION_ID_LENGTH,
  MCP_STDIO_MAX_CWD_LENGTH,
  MCP_STDIO_MAX_ENV_BYTES,
  MCP_STDIO_MAX_ENV_KEY_LENGTH,
  MCP_STDIO_MAX_ENV_VALUE_LENGTH,
  MCP_STDIO_MAX_ENV_VARS,
  MCP_STDIO_MAX_MESSAGE_BYTES,
  MCP_STDIO_MAX_PID,
  MCP_STDIO_MAX_QUEUE_BYTES,
  MCP_STDIO_MAX_QUEUE_MESSAGES,
  MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS,
  type McpStdioCloseParams,
  type McpStdioCloseResult,
  type McpStdioOpenParams,
  type McpStdioOpenResult,
  type McpStdioReceiveParams,
  type McpStdioReceiveResult,
  type McpStdioSendParams,
  type McpStdioSendResult,
  type McpStdioServerParameters,
  type McpStdioStatusResult,
} from "./types.js";

export class McpStdioValidationError extends Error {
  readonly code = "MCP_STDIO_INVALID_ARGUMENT";

  constructor(message: string) {
    super(message);
    this.name = "McpStdioValidationError";
  }
}

export function normalizeServerParameters(
  parameters: McpStdioServerParameters,
): McpStdioServerParameters & { args: string[]; cwd: string } {
  if (!isRecord(parameters)) {
    invalid("server parameters must be an object");
  }
  assertKeys(parameters, ["command", "args", "cwd", "env"]);
  const command = boundedString(
    parameters.command,
    "command",
    MCP_STDIO_MAX_COMMAND_LENGTH,
    false,
  );
  const argsValue = parameters.args ?? [];
  if (!Array.isArray(argsValue) || argsValue.length > MCP_STDIO_MAX_ARGUMENTS) {
    invalid(
      `args must be an array with at most ${MCP_STDIO_MAX_ARGUMENTS} items`,
    );
  }
  const args = argsValue.map((argument, index) =>
    boundedString(
      argument,
      `args[${index}]`,
      MCP_STDIO_MAX_ARGUMENT_LENGTH,
      true,
    ),
  );
  const cwd = boundedString(
    parameters.cwd ?? process.cwd(),
    "cwd",
    MCP_STDIO_MAX_CWD_LENGTH,
    false,
  );
  if (!isAbsolutePath(cwd))
    invalid("cwd must be an absolute POSIX or Windows path");
  const env =
    parameters.env === undefined ? undefined : validateEnv(parameters.env);
  return { command, args, cwd, ...(env === undefined ? {} : { env }) };
}

export function validateOpenParams(value: unknown): McpStdioOpenParams {
  if (!isRecord(value)) invalid("open params must be an object");
  assertKeys(value, ["connection_id", "command", "args", "cwd", "env"]);
  if (!Object.hasOwn(value, "args")) invalid("open params require args");
  if (!Object.hasOwn(value, "cwd")) invalid("open params require cwd");
  const connection_id = validateConnectionId(value.connection_id);
  const normalized = normalizeServerParameters({
    command: value.command as string,
    args: value.args as string[],
    cwd: value.cwd as string,
    env: value.env as Record<string, string> | undefined,
  });
  return { connection_id, ...normalized };
}

export function validateOpenResult(value: unknown): McpStdioOpenResult {
  if (!isRecord(value)) invalid("open result must be an object");
  assertKeys(value, ["connection_id", "pid"]);
  const connection_id = validateConnectionId(value.connection_id);
  const pid = validateBoundedPositiveInteger(
    value.pid,
    "pid",
    MCP_STDIO_MAX_PID,
  );
  return { connection_id, pid };
}

export function validateSendParams(value: unknown): McpStdioSendParams {
  if (!isRecord(value)) invalid("send params must be an object");
  assertKeys(value, ["connection_id", "message"]);
  return {
    connection_id: validateConnectionId(value.connection_id),
    message: validateMessage(value.message),
  };
}

export function validateSendResult(value: unknown): McpStdioSendResult {
  if (!isRecord(value)) invalid("send result must be an object");
  assertKeys(value, ["accepted"]);
  if (value.accepted !== true) invalid("send result must be accepted");
  return { accepted: true };
}

export function validateReceiveParams(value: unknown): McpStdioReceiveParams {
  if (!isRecord(value)) invalid("receive params must be an object");
  assertKeys(value, ["connection_id", "timeout_ms"]);
  const result: McpStdioReceiveParams = {
    connection_id: validateConnectionId(value.connection_id),
  };
  if (value.timeout_ms !== undefined) {
    result.timeout_ms = validateTimeout(value.timeout_ms);
  }
  return result;
}

export function validateReceiveResult(value: unknown): McpStdioReceiveResult {
  if (!isRecord(value)) invalid("receive result must be an object");
  assertKeys(value, ["message", "closed"]);
  if (typeof value.closed !== "boolean") invalid("closed must be a boolean");
  return {
    message: value.message === null ? null : validateMessage(value.message),
    closed: value.closed,
  };
}

export function validateCloseParams(value: unknown): McpStdioCloseParams {
  if (!isRecord(value)) invalid("close params must be an object");
  assertKeys(value, ["connection_id"]);
  return { connection_id: validateConnectionId(value.connection_id) };
}

export function validateCloseResult(value: unknown): McpStdioCloseResult {
  if (!isRecord(value)) invalid("close result must be an object");
  assertKeys(value, ["closed"]);
  if (typeof value.closed !== "boolean") invalid("closed must be a boolean");
  return { closed: value.closed };
}

export function validateStatusParams(value: unknown): {
  connection_id?: string;
} {
  if (!isRecord(value)) invalid("status params must be an object");
  assertKeys(value, ["connection_id"]);
  return value.connection_id === undefined
    ? {}
    : { connection_id: validateConnectionId(value.connection_id) };
}

export function validateStatusResult(value: unknown): McpStdioStatusResult {
  if (!isRecord(value)) invalid("status result must be an object");
  assertKeys(value, ["connections"]);
  if (!Array.isArray(value.connections))
    invalid("connections must be an array");
  return {
    connections: value.connections.map((connection, index) => {
      if (!isRecord(connection))
        invalid(`connections[${index}] must be an object`);
      assertKeys(connection, [
        "connection_id",
        "pid",
        "state",
        "queued_messages",
        "queued_bytes",
        "stderr_bytes",
      ]);
      if (
        connection.state !== "running" &&
        connection.state !== "closed" &&
        connection.state !== "failed"
      ) {
        invalid(`connections[${index}].state is invalid`);
      }
      return {
        connection_id: validateConnectionId(connection.connection_id),
        pid: validateBoundedPositiveInteger(
          connection.pid,
          `connections[${index}].pid`,
          MCP_STDIO_MAX_PID,
        ),
        state: connection.state,
        queued_messages: validateBoundedNonnegativeInteger(
          connection.queued_messages,
          `connections[${index}].queued_messages`,
          MCP_STDIO_MAX_QUEUE_MESSAGES,
        ),
        queued_bytes: validateBoundedNonnegativeInteger(
          connection.queued_bytes,
          `connections[${index}].queued_bytes`,
        ),
        stderr_bytes: validateBoundedNonnegativeInteger(
          connection.stderr_bytes,
          `connections[${index}].stderr_bytes`,
        ),
      };
    }),
  };
}

export function validateConnectionId(value: unknown): string {
  const id = boundedString(
    value,
    "connection_id",
    MCP_STDIO_MAX_CONNECTION_ID_LENGTH,
    false,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id)) {
    invalid("connection_id contains invalid characters");
  }
  return id;
}

export function validateMessage(value: unknown): JSONRPCMessage {
  if (!isRecord(value)) invalid("message must be a JSON object");
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    invalid("message must be JSON serializable");
  }
  if (encoded === undefined) invalid("message must be JSON serializable");
  const bytes = new TextEncoder().encode(encoded).byteLength;
  if (bytes > MCP_STDIO_MAX_MESSAGE_BYTES) {
    invalid(`message exceeds ${MCP_STDIO_MAX_MESSAGE_BYTES} bytes`);
  }
  assertJsonValue(value, "message");
  validateJsonRpcEnvelope(value);
  return value as JSONRPCMessage;
}

export function validateTimeout(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS
  ) {
    invalid(
      `timeout_ms must be an integer from 1 to ${MCP_STDIO_MAX_RECEIVE_TIMEOUT_MS}`,
    );
  }
  return value as number;
}

function validateEnv(value: unknown): Record<string, string> {
  if (!isRecord(value)) invalid("env must be an object");
  const keys = Object.keys(value);
  if (keys.length > MCP_STDIO_MAX_ENV_VARS) {
    invalid(`env has more than ${MCP_STDIO_MAX_ENV_VARS} variables`);
  }
  const result: Record<string, string> = {};
  let totalBytes = 0;
  for (const key of keys) {
    boundedString(key, "env key", MCP_STDIO_MAX_ENV_KEY_LENGTH, false);
    const uppercaseKey = key.toUpperCase();
    if (
      uppercaseKey === "AUTHORIZATION" ||
      uppercaseKey.endsWith("_AUTHORIZATION") ||
      uppercaseKey === "VEXZY_API_KEY" ||
      (uppercaseKey.includes("VEXZY") &&
        [
          "KEY",
          "TOKEN",
          "SECRET",
          "PASSWORD",
          "PASSWD",
          "AUTH",
          "CREDENTIAL",
          "BEARER",
          "COOKIE",
          "PRIVATE",
          "CERT",
        ].some((marker) => uppercaseKey.includes(marker)))
    ) {
      invalid(`env key ${key} is forbidden`);
    }
    if (key.includes("=")) invalid(`env key ${key} is invalid`);
    const item = boundedString(
      value[key],
      `env[${key}]`,
      MCP_STDIO_MAX_ENV_VALUE_LENGTH,
      true,
    );
    totalBytes += byteLength(key) + byteLength(item);
    if (totalBytes > MCP_STDIO_MAX_ENV_BYTES) {
      invalid(`env exceeds ${MCP_STDIO_MAX_ENV_BYTES} bytes`);
    }
    result[key] = item;
  }
  return result;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function assertKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) invalid(`unexpected field ${key}`);
  }
}

function boundedString(
  value: unknown,
  name: string,
  maximum: number,
  allowEmpty: boolean,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    invalid(`${name} must be a non-empty string`);
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    invalid(`${name} must not contain control characters`);
  }
  if (new TextEncoder().encode(value).byteLength > maximum) {
    invalid(`${name} exceeds ${maximum} bytes`);
  }
  return value as string;
}

function validatePositiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    invalid(`${name} must be a positive integer`);
  return value as number;
}

function validateBoundedPositiveInteger(
  value: unknown,
  name: string,
  maximum: number,
): number {
  const result = validatePositiveInteger(value, name);
  if (result > maximum) invalid(`${name} exceeds its bound`);
  return result;
}

function validateNonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    invalid(`${name} must be a nonnegative integer`);
  return value as number;
}

function validateBoundedNonnegativeInteger(
  value: unknown,
  name: string,
  maximum = MCP_STDIO_MAX_QUEUE_BYTES,
): number {
  const result = validateNonnegativeInteger(value, name);
  if (result > maximum) invalid(`${name} exceeds its bound`);
  return result;
}

function assertJsonValue(value: unknown, name: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    invalid(`${name} contains a non-finite number`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${name}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) {
      assertJsonValue(item, `${name}.${key}`);
    }
    return;
  }
  invalid(`${name} contains a non-JSON value`);
}

function validateJsonRpcEnvelope(value: Record<string, unknown>): void {
  if (value.jsonrpc !== "2.0") invalid("message.jsonrpc must be '2.0'");

  if (Object.hasOwn(value, "method")) {
    boundedString(
      value.method,
      "request method",
      MCP_STDIO_MAX_COMMAND_LENGTH,
      false,
    );
    if (Object.hasOwn(value, "id")) {
      assertKeys(value, ["jsonrpc", "method", "id", "params"]);
      validateRequestId(value.id);
    } else {
      assertKeys(value, ["jsonrpc", "method", "params"]);
    }
    if (Object.hasOwn(value, "params"))
      validateStructuredValue(value.params, "message.params");
    return;
  }

  assertKeys(value, ["jsonrpc", "id", "result", "error"]);
  if (!Object.hasOwn(value, "id")) invalid("response requires id");
  validateResponseId(value.id);
  const hasResult = Object.hasOwn(value, "result");
  const hasError = Object.hasOwn(value, "error");
  if (hasResult === hasError) {
    invalid("response must contain exactly one of result or error");
  }
  if (hasResult) {
    assertJsonValue(value.result, "message.result");
  } else {
    validateJsonRpcError(value.error);
  }
}

function validateStructuredValue(value: unknown, name: string): void {
  if (!Array.isArray(value) && !isRecord(value)) {
    invalid(`${name} must be an object or array`);
  }
  assertJsonValue(value, name);
}

function validateRequestId(value: unknown): void {
  if (
    (typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && !Number.isSafeInteger(value))
  ) {
    invalid("request id must be a string or safe integer");
  }
}

function validateResponseId(value: unknown): void {
  if (
    value !== null &&
    ((typeof value !== "string" && typeof value !== "number") ||
      (typeof value === "number" && !Number.isSafeInteger(value)))
  ) {
    invalid("response id must be null, a string, or a safe integer");
  }
}

function validateJsonRpcError(value: unknown): void {
  if (!isRecord(value)) invalid("response error must be an object");
  assertKeys(value, ["code", "message", "data"]);
  if (!Number.isSafeInteger(value.code)) {
    invalid("response error code must be an integer");
  }
  if (typeof value.message !== "string") {
    invalid("response error message must be a string");
  }
  if (Object.hasOwn(value, "data"))
    assertJsonValue(value.data, "message.error.data");
}

function isAbsolutePath(value: string): boolean {
  return (
    value.startsWith("/") ||
    /^\\\\[^\\/]+[\\/][^\\/]+/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(message: string): never {
  throw new McpStdioValidationError(message);
}
