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
import {
  MODEL_CATALOG_GET_METHOD,
  MODEL_CATALOG_PUT_METHOD,
  MODEL_CATALOG_STATUS_METHOD,
  type ModelCatalogDaemonTransport,
  type ModelCatalogFallback,
  type ModelCatalogGetResult,
  type ModelCatalogModel,
  type ModelCatalogPutResult,
  type ModelCatalogRequestOptions,
  type ModelCatalogSnapshot,
  type ModelCatalogStatusResult,
} from "./types.js";
import {
  freezeModelCatalogSnapshot,
  normalizeModelCatalogSnapshot,
  validateModelCatalogGetResult,
  validateModelCatalogPutResult,
  validateModelCatalogSnapshot,
  validateModelCatalogStatusResult,
} from "./validation.js";

const FALLBACK_MARKER = Object.freeze({ modelCatalogFallbackMarker: true });

export class ModelCatalogDaemonClient {
  private readonly transport: ModelCatalogDaemonTransport;
  private snapshotValue: ModelCatalogSnapshot | undefined;

  constructor(transport: ModelCatalogDaemonTransport = getDaemonManager()) {
    if (!transport.request && !transport.requestWithFallback) {
      throw new TypeError(
        "Model catalog transport must expose request or requestWithFallback",
      );
    }
    this.transport = transport;
  }

  getSnapshot(): ModelCatalogSnapshot | undefined {
    return this.snapshotValue;
  }

  async get(
    options?: ModelCatalogRequestOptions,
  ): Promise<ModelCatalogSnapshot | null> {
    const result = validateModelCatalogGetResult(
      await this.request<ModelCatalogGetResult>(
        MODEL_CATALOG_GET_METHOD,
        {},
        options,
      ),
    );
    return this.remember(result.snapshot);
  }

  async put(
    snapshot: ModelCatalogSnapshot,
    options?: ModelCatalogRequestOptions,
  ): Promise<ModelCatalogPutResult> {
    // Normalize before dispatch so provider metadata can never enter daemon IPC.
    const safeSnapshot = freezeModelCatalogSnapshot(
      normalizeModelCatalogSnapshot(snapshot),
    );
    const result = validateModelCatalogPutResult(
      await this.request(
        MODEL_CATALOG_PUT_METHOD,
        { snapshot: safeSnapshot },
        options,
      ),
    );
    if (result.stored) this.snapshotValue = safeSnapshot;
    return result;
  }

  async status(
    options?: ModelCatalogRequestOptions,
  ): Promise<ModelCatalogStatusResult> {
    return validateModelCatalogStatusResult(
      await this.request<ModelCatalogStatusResult>(
        MODEL_CATALOG_STATUS_METHOD,
        {},
        options,
      ),
    );
  }

  async getWithFallback(
    fallback: ModelCatalogFallback<ModelCatalogSnapshot | null>,
    options?: ModelCatalogRequestOptions,
  ): Promise<DaemonCallResult<ModelCatalogSnapshot | null>> {
    const result = await this.readWithFallback<ModelCatalogGetResult>(
      MODEL_CATALOG_GET_METHOD,
      {},
      async () => ({ snapshot: await fallback() }),
      validateModelCatalogGetResult,
      options,
    );
    return {
      ...result,
      value: this.remember(result.value.snapshot),
    };
  }

  async statusWithFallback(
    fallback: ModelCatalogFallback<ModelCatalogStatusResult>,
    options?: ModelCatalogRequestOptions,
  ): Promise<DaemonCallResult<ModelCatalogStatusResult>> {
    return this.readWithFallback(
      MODEL_CATALOG_STATUS_METHOD,
      {},
      fallback,
      validateModelCatalogStatusResult,
      options,
    );
  }

  private async request<T>(
    method: string,
    params: unknown,
    options?: ModelCatalogRequestOptions,
  ): Promise<T> {
    if (this.transport.request) {
      return this.transport.request<T>(method, params, options);
    }
    if (!this.transport.requestWithFallback) {
      throw new DaemonClientError(
        "DAEMON_REQUEST_UNAVAILABLE",
        "Daemon transport does not expose request",
      );
    }
    const result = await this.transport.requestWithFallback<T>(
      method,
      params,
      FALLBACK_MARKER as T,
      options,
    );
    if (result.source === "fallback") {
      throw (
        result.error ??
        new DaemonClientError(
          "DAEMON_REQUEST_UNAVAILABLE",
          "Daemon request was unavailable",
        )
      );
    }
    return result.value;
  }

  private async readWithFallback<T>(
    method: string,
    params: unknown,
    fallback: ModelCatalogFallback<T>,
    validator: (value: unknown) => T,
    options?: ModelCatalogRequestOptions,
  ): Promise<DaemonCallResult<T>> {
    if (this.transport.requestWithFallback) {
      try {
        const result = await this.transport.requestWithFallback<unknown>(
          method,
          params,
          FALLBACK_MARKER,
          options,
        );
        if (result.source === "daemon") {
          return { source: "daemon", value: validator(result.value) };
        }
        const error = result.error;
        if (!canFallback(error)) throw error;
        const value =
          result.value === FALLBACK_MARKER ? await fallback() : result.value;
        return {
          source: "fallback",
          value: validator(value),
          reason: classifyDaemonFallback(error),
          ...(error === undefined ? {} : { error }),
        };
      } catch (error) {
        if (!canFallback(error)) throw error;
        return {
          source: "fallback",
          value: validator(await fallback()),
          reason: classifyDaemonFallback(error),
          error,
        };
      }
    }

    try {
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
      if (!canFallback(error)) throw error;
      return {
        source: "fallback",
        value: validator(await fallback()),
        reason: classifyDaemonFallback(error),
        error,
      };
    }
  }

  private remember(
    snapshot: ModelCatalogSnapshot | null,
  ): ModelCatalogSnapshot | null {
    if (snapshot === null) {
      this.snapshotValue = undefined;
      return null;
    }
    const safe = freezeModelCatalogSnapshot(
      validateModelCatalogSnapshot(snapshot),
    );
    this.snapshotValue = safe;
    return safe;
  }
}

function canFallback(error: unknown): boolean {
  if (error === undefined) return false;
  if (error instanceof DaemonCancelledError) return false;
  if (error instanceof DaemonRemoteError) return false;
  if (error instanceof Error && error.name === "DaemonProtocolError")
    return false;
  if (error instanceof Error && error.name === "ModelCatalogProtocolError")
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

export type {
  ModelCatalogDaemonTransport,
  ModelCatalogFallback,
  ModelCatalogModel,
  ModelCatalogRequestOptions,
  ModelCatalogSnapshot,
  ModelCatalogStatusResult,
};
