import {
  DaemonCancelledError,
  DaemonClientError,
  DaemonDisabledError,
  DaemonDisconnectedError,
  DaemonRemoteError,
  DaemonTimeoutError,
  classifyDaemonFallback,
} from "../daemon/errors.js";
import { getDaemonManager } from "../daemon/manager.js";
import type { DaemonCallResult } from "../daemon/types.js";
import { normalizeSessionIndexError } from "./errors.js";
import {
  type SessionIndexDaemonTransport,
  type SessionIndexGetParams,
  type SessionIndexListParams,
  type SessionIndexRecord,
  type SessionIndexRequestOptions,
  type SessionIndexResponse,
  type SessionIndexSearchParams,
  validateGetParams,
  validateGetResult,
  validateListParams,
  validateListResult,
  validateRemoveParams,
  validateRemoveResult,
  validateSearchParams,
  validateSearchResult,
  validateSessionId,
  validateSessionRecord,
  validateUpsertResult,
} from "./protocol.js";

export type SessionIndexFallback<T> = () => T | Promise<T>;

export class SessionIndexDaemonClient {
  private readonly transport: SessionIndexDaemonTransport;

  constructor(transport: SessionIndexDaemonTransport = getDaemonManager()) {
    if (!transport.request && !transport.requestWithFallback) {
      throw new TypeError(
        "Session index transport must expose request or requestWithFallback",
      );
    }
    this.transport = transport;
  }

  async upsert(
    session: SessionIndexRecord,
    options?: SessionIndexRequestOptions,
  ): Promise<SessionIndexResponse["upsert"]> {
    return this.call(
      "session_index.upsert",
      validateSessionRecord(session, "upsert params"),
      validateUpsertResult,
      options,
    );
  }

  async get(
    sessionId: string,
    options?: SessionIndexRequestOptions,
  ): Promise<SessionIndexResponse["get"]> {
    const params: SessionIndexGetParams = validateGetParams(
      { session_id: sessionId },
      "get params",
    );
    return this.call("session_index.get", params, validateGetResult, options);
  }

  async list(
    params: SessionIndexListParams = {},
    options?: SessionIndexRequestOptions,
  ): Promise<SessionIndexResponse["list"]> {
    return this.call(
      "session_index.list",
      validateListParams(params),
      validateListResult,
      options,
    );
  }

  async search(
    params: SessionIndexSearchParams,
    options?: SessionIndexRequestOptions,
  ): Promise<SessionIndexResponse["search"]> {
    return this.call(
      "session_index.search",
      validateSearchParams(params),
      validateSearchResult,
      options,
    );
  }

  async remove(
    sessionId: string,
    options?: SessionIndexRequestOptions,
  ): Promise<SessionIndexResponse["remove"]> {
    const params = validateRemoveParams(
      { session_id: sessionId },
      "remove params",
    );
    return this.call(
      "session_index.remove",
      params,
      validateRemoveResult,
      options,
    );
  }

  async getWithFallback(
    sessionId: string,
    fallback: SessionIndexFallback<SessionIndexResponse["get"]>,
    options?: SessionIndexRequestOptions,
  ): Promise<DaemonCallResult<SessionIndexResponse["get"]>> {
    const params = validateGetParams({ session_id: sessionId }, "get params");
    return this.callReadWithFallback(
      "session_index.get",
      params,
      fallback,
      validateGetResult,
      options,
    );
  }

  async listWithFallback(
    params: SessionIndexListParams,
    fallback: SessionIndexFallback<SessionIndexResponse["list"]>,
    options?: SessionIndexRequestOptions,
  ): Promise<DaemonCallResult<SessionIndexResponse["list"]>> {
    return this.callReadWithFallback(
      "session_index.list",
      validateListParams(params),
      fallback,
      validateListResult,
      options,
    );
  }

  async searchWithFallback(
    params: SessionIndexSearchParams,
    fallback: SessionIndexFallback<SessionIndexResponse["search"]>,
    options?: SessionIndexRequestOptions,
  ): Promise<DaemonCallResult<SessionIndexResponse["search"]>> {
    return this.callReadWithFallback(
      "session_index.search",
      validateSearchParams(params),
      fallback,
      validateSearchResult,
      options,
    );
  }

  private async call<T>(
    method: string,
    params: unknown,
    validator: (value: unknown) => T,
    options?: SessionIndexRequestOptions,
  ): Promise<T> {
    try {
      if (this.transport.request) {
        return validator(
          await this.transport.request<unknown>(method, params, options),
        );
      }
      if (this.transport.requestWithFallback) {
        const marker = Object.freeze({ sessionIndexFallbackMarker: true });
        const result = await this.transport.requestWithFallback<unknown>(
          method,
          params,
          marker,
          options,
        );
        if (result.source === "fallback" && result.value === marker) {
          throw (
            result.error ??
            new DaemonClientError(
              "DAEMON_UNAVAILABLE",
              "Daemon request was unavailable",
            )
          );
        }
        return validator(result.value);
      }
      throw new DaemonClientError(
        "DAEMON_REQUEST_UNAVAILABLE",
        "Daemon transport does not expose request",
      );
    } catch (error) {
      throw normalizeSessionIndexError(error);
    }
  }

  private async callReadWithFallback<T>(
    method: string,
    params: unknown,
    fallback: SessionIndexFallback<T>,
    validator: (value: unknown) => T,
    options?: SessionIndexRequestOptions,
  ): Promise<DaemonCallResult<T>> {
    try {
      if (this.transport.requestWithFallback) {
        const marker = Object.freeze({ sessionIndexFallbackMarker: true });
        const result = await this.transport.requestWithFallback<unknown>(
          method,
          params,
          marker,
          options,
        );
        if (result.source === "fallback") {
          const error = normalizeSessionIndexError(result.error);
          if (result.value === marker) {
            if (!canFallbackRead(error)) throw error;
            return {
              source: "fallback",
              value: validator(await fallback()),
              reason: classifyDaemonFallback(error),
              error,
            };
          }
          if (!canFallbackRead(error)) throw error;
          return {
            source: "fallback",
            value: validator(result.value),
            reason: classifyDaemonFallback(error),
            ...(error === undefined ? {} : { error }),
          };
        }
        return {
          source: "daemon",
          value: validator(result.value),
        };
      }
      if (!this.transport.request) {
        throw new DaemonClientError(
          "DAEMON_REQUEST_UNAVAILABLE",
          "Daemon transport does not expose request",
        );
      }
      return {
        source: "daemon",
        value: validator(
          await this.transport.request<unknown>(method, params, options),
        ),
      };
    } catch (error) {
      const normalized = normalizeSessionIndexError(error);
      if (!canFallbackRead(normalized)) throw normalized;
      return {
        source: "fallback",
        value: validator(await fallback()),
        reason: classifyDaemonFallback(normalized),
        error: normalized,
      };
    }
  }
}

function canFallbackRead(error: unknown): boolean {
  if (error === undefined) return false;
  if (error instanceof DaemonCancelledError) return false;
  if (error instanceof DaemonRemoteError) return false;
  if (error instanceof Error && error.name === "DaemonProtocolError")
    return false;
  if (
    error instanceof Error &&
    (error.name === "SessionIndexProtocolError" ||
      error.name === "SessionIndexDaemonError")
  )
    return false;
  if (error instanceof DaemonDisabledError) return true;
  if (error instanceof DaemonDisconnectedError) return true;
  if (error instanceof DaemonTimeoutError) return true;
  if (error instanceof DaemonClientError) {
    return (
      error.code === "DAEMON_REQUEST_UNAVAILABLE" ||
      error.code === "DAEMON_UNAVAILABLE"
    );
  }
  return false;
}
