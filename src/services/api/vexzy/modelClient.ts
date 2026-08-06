import {
  createVexzyConfig,
  getVexzyConfig,
  type VexzyConfig,
} from "./config.js";
import { createVexzyRequestInit } from "./auth.js";
import {
  APIError,
  createVexzyError,
  getVexzyRetryDelayMs,
  markVexzyCompatibilityKind,
  shouldRetryVexzy,
  VexzyError,
} from "./errors.js";
import {
  createVexzyModelRegistry,
  type VexzyModelRegistry,
} from "./modelRegistry.js";
import { getDaemonManager } from "../../../runtime/daemon/manager.js";
import {
  ModelCatalogDaemonClient,
  createModelCatalogSnapshot,
  type ModelCatalogSnapshot,
} from "../../../runtime/modelBroker/index.js";

export const DEFAULT_VEXZY_MODEL_TIMEOUT_MS = 10_000;

export type VexzyFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type VexzyModelClientErrorCode =
  | "aborted"
  | "timeout"
  | "network"
  | "invalid_response";

export class VexzyModelClientError extends APIError {
  readonly code: VexzyModelClientErrorCode;

  constructor(code: VexzyModelClientErrorCode, cause?: unknown) {
    super(undefined, undefined, getClientErrorMessage(code), undefined);
    this.name = "VexzyModelClientError";
    this.code = code;
    if (code === "aborted") markVexzyCompatibilityKind(this, "abort");
    if (code === "timeout") {
      markVexzyCompatibilityKind(this, "timeout");
      markVexzyCompatibilityKind(this, "connection");
    }
    if (code === "network") markVexzyCompatibilityKind(this, "connection");
    if (cause instanceof Error) {
      Object.defineProperty(this, "cause", {
        configurable: true,
        enumerable: false,
        value: new Error("Vexzy model request failed"),
        writable: true,
      });
    }
  }
}

export interface VexzyModelClientOptions {
  readonly apiKey?: string;
  readonly config?: VexzyConfig;
  readonly fetch?: VexzyFetch;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Explicit cache boundary for tests/embedding; false disables daemon cache. */
  readonly catalogCache?: VexzyModelCatalogCache | false;
}

export interface VexzyModelCatalogCache {
  get(options?: VexzyModelRequestOptions): Promise<ModelCatalogSnapshot | null>;
  put(
    snapshot: ModelCatalogSnapshot,
    options?: VexzyModelRequestOptions,
  ): Promise<{ readonly stored: boolean }>;
}

export interface VexzyModelRequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface VexzyModelLoadOptions extends VexzyModelRequestOptions {
  readonly refresh?: boolean;
  readonly force?: boolean;
  readonly forceRefresh?: boolean;
}

export interface VexzyModelSnapshot {
  readonly registry: VexzyModelRegistry;
  readonly fetchedAt: number;
  /** Unconsumed clone of the provider response for SDK-compatible metadata. */
  readonly response?: Response;
}

interface CombinedSignal {
  readonly signal: AbortSignal;
  readonly wasTimedOut: () => boolean;
  cleanup(): void;
}

export class VexzyModelClient {
  private readonly config: VexzyConfig;
  private readonly fetchImpl: VexzyFetch;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly sleepImpl: (
    delayMs: number,
    signal: AbortSignal,
  ) => Promise<void>;
  private readonly explicitCatalogCache: VexzyModelCatalogCache | undefined;
  private readonly useDefaultCatalogCache: boolean;
  private defaultCatalogCache: VexzyModelCatalogCache | undefined;
  private cachedSnapshot: VexzyModelSnapshot | undefined;
  private initialInFlight: Promise<VexzyModelRegistry> | undefined;
  private refreshInFlight: Promise<VexzyModelRegistry> | undefined;

  constructor(options: VexzyModelClientOptions = {}) {
    this.config =
      options.config ??
      (options.apiKey === undefined
        ? getVexzyConfig()
        : createVexzyConfig(options.apiKey));
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.defaultTimeoutMs = validateTimeout(
      options.timeoutMs ?? DEFAULT_VEXZY_MODEL_TIMEOUT_MS,
    );
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? sleep;
    this.explicitCatalogCache =
      options.catalogCache === false ? undefined : options.catalogCache;
    this.useDefaultCatalogCache = options.catalogCache === undefined;
  }

  get snapshot(): VexzyModelSnapshot | undefined {
    return this.cachedSnapshot;
  }

  getSnapshot(): VexzyModelSnapshot | undefined {
    return this.cachedSnapshot;
  }

  getModels(options: VexzyModelLoadOptions = {}): Promise<VexzyModelRegistry> {
    const forceRefresh =
      options.refresh === true ||
      options.force === true ||
      options.forceRefresh === true;

    if (forceRefresh) return this.refresh(options);

    if (this.cachedSnapshot !== undefined) {
      return Promise.resolve(this.cachedSnapshot.registry);
    }

    if (this.initialInFlight !== undefined) return this.initialInFlight;

    const request = this.loadInitial(options);
    this.initialInFlight = request;
    void request.then(
      () => {
        if (this.initialInFlight === request) this.initialInFlight = undefined;
      },
      () => {
        if (this.initialInFlight === request) this.initialInFlight = undefined;
      },
    );
    return request;
  }

  listModels(options: VexzyModelLoadOptions = {}): Promise<VexzyModelRegistry> {
    return this.getModels(options);
  }

  fetchModels(
    options: VexzyModelLoadOptions = {},
  ): Promise<VexzyModelRegistry> {
    return this.getModels(options);
  }

  getRegistry(
    options: VexzyModelLoadOptions = {},
  ): Promise<VexzyModelRegistry> {
    return this.getModels(options);
  }

  refresh(options: VexzyModelRequestOptions = {}): Promise<VexzyModelRegistry> {
    if (this.refreshInFlight !== undefined) return this.refreshInFlight;

    const request = this.loadFresh(options);
    this.refreshInFlight = request;
    void request.then(
      () => {
        if (this.refreshInFlight === request) this.refreshInFlight = undefined;
      },
      () => {
        if (this.refreshInFlight === request) this.refreshInFlight = undefined;
      },
    );
    return request;
  }

  private async loadInitial(
    options: VexzyModelRequestOptions,
  ): Promise<VexzyModelRegistry> {
    if (options.signal?.aborted) {
      throw new VexzyModelClientError("aborted");
    }
    const cache = this.resolveCatalogCache();
    if (cache !== undefined) {
      try {
        const snapshot = await cache.get(options);
        if (options.signal?.aborted) {
          throw new VexzyModelClientError("aborted");
        }
        if (snapshot !== null) {
          const cached = registryFromCatalogSnapshot(snapshot);
          if (
            this.cachedSnapshot === undefined ||
            snapshot.fetched_at_ms >= this.cachedSnapshot.fetchedAt
          ) {
            this.cachedSnapshot = {
              registry: cached,
              fetchedAt: snapshot.fetched_at_ms,
              response: createDaemonCatalogResponse(),
            };
          }
          const resolved = this.cachedSnapshot.registry;
          // A daemon hit makes catalog metadata available immediately. The
          // provider refresh runs independently and never blocks this read.
          void this.refresh({ timeoutMs: options.timeoutMs }).catch(
            () => undefined,
          );
          return resolved;
        }
      } catch (error) {
        if (error instanceof VexzyModelClientError) throw error;
        // Cache availability/protocol failures must not replace the provider
        // source of truth. The network path below remains authoritative.
      }
    }
    return this.refresh(options);
  }

  private async loadFresh(
    options: VexzyModelRequestOptions,
  ): Promise<VexzyModelRegistry> {
    const combined = createCombinedSignal(
      options.signal,
      validateTimeout(options.timeoutMs ?? this.defaultTimeoutMs),
    );

    try {
      return await this.requestRegistry(combined.signal);
    } catch (error) {
      if (combined.signal.aborted) {
        throw new VexzyModelClientError(
          combined.wasTimedOut() ? "timeout" : "aborted",
        );
      }
      if (error instanceof VexzyError) throw error;
      if (error instanceof VexzyModelClientError) throw error;
      if (error instanceof APIError) throw error;
      throw new VexzyModelClientError("network");
    } finally {
      combined.cleanup();
    }
  }

  private async requestRegistry(
    signal: AbortSignal,
  ): Promise<VexzyModelRegistry> {
    if (signal.aborted) throw new VexzyModelClientError("aborted");

    let retryCount = 0;

    while (true) {
      if (signal.aborted) throw new VexzyModelClientError("aborted");

      let response: Response;
      try {
        response = await this.fetchImpl(
          this.config.endpoints.models,
          createVexzyRequestInit(this.config.apiKey, {
            method: "GET",
            headers: { Accept: "application/json" },
            signal,
          }),
        );
      } catch (error) {
        if (signal.aborted) throw error;
        throw new VexzyModelClientError("network", error);
      }

      if (response.ok) {
        const rawResponse = response.clone();
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          throw new VexzyModelClientError("invalid_response");
        }

        let registry: VexzyModelRegistry;
        try {
          registry = createVexzyModelRegistry(payload);
        } catch {
          throw new VexzyModelClientError("invalid_response");
        }

        const observedAt = validateCatalogTimestamp(this.now());
        const fetchedAt = Math.max(
          observedAt,
          (this.cachedSnapshot?.fetchedAt ?? -1) + 1,
        );
        this.cachedSnapshot = {
          registry,
          fetchedAt,
          response: rawResponse,
        };
        this.publishCatalogSnapshot(registry, fetchedAt);
        return registry;
      }

      const error = createVexzyError(response, this.now());
      const kind = error.kind;
      const rateLimited = error.status === 429 || kind === "rate_limit";
      const unavailable =
        error.status === 503 || kind === "service_unavailable";
      const transient = rateLimited || unavailable;
      const retryable = error.retryable === true;
      const maxRetries =
        typeof error.maxRetries === "number" &&
        Number.isInteger(error.maxRetries) &&
        error.maxRetries >= 0
          ? error.maxRetries
          : 0;

      if (
        transient &&
        shouldRetryVexzy({ retryable, maxRetries }, retryCount)
      ) {
        const retryKind = rateLimited
          ? "rate_limit"
          : unavailable
            ? "service_unavailable"
            : "http";
        await this.sleepImpl(
          getVexzyRetryDelayMs(
            { kind: retryKind, retryAfterMs: error.retryAfterMs },
            retryCount,
          ),
          signal,
        );
        retryCount += 1;
        continue;
      }

      if (transient && this.cachedSnapshot !== undefined) {
        return this.cachedSnapshot.registry;
      }

      throw error;
    }
  }

  private resolveCatalogCache(): VexzyModelCatalogCache | undefined {
    if (this.explicitCatalogCache !== undefined) {
      return this.explicitCatalogCache;
    }
    if (!this.useDefaultCatalogCache) return undefined;
    const manager = getDaemonManager();
    if (manager.status().state !== "ready") return undefined;
    this.defaultCatalogCache ??= new ModelCatalogDaemonClient(manager);
    return this.defaultCatalogCache;
  }

  private publishCatalogSnapshot(
    registry: VexzyModelRegistry,
    fetchedAt: number,
  ): void {
    const cache = this.resolveCatalogCache();
    if (cache === undefined) return;
    let snapshot: ModelCatalogSnapshot;
    try {
      snapshot = createModelCatalogSnapshot(registry.models, fetchedAt);
    } catch {
      return;
    }
    void cache.put(snapshot).catch(() => undefined);
  }
}

function registryFromCatalogSnapshot(
  snapshot: ModelCatalogSnapshot,
): VexzyModelRegistry {
  return createVexzyModelRegistry({
    object: "list",
    data: snapshot.models.map((model) => ({
      id: model.id,
      object: "model",
      owned_by: "vexzy",
      display_name: model.display_name,
      available: model.available,
      ...(model.status === undefined ? {} : { status: model.status }),
      context_length: model.context_length,
      supported_reasoning_efforts: [...model.efforts],
      input_modalities: [...model.modalities.input],
      output_modalities: [...model.modalities.output],
      capabilities: { ...model.capabilities },
      ...(model.output_limit === undefined
        ? {}
        : { output_limit: model.output_limit }),
      ...(model.output_credits_per_million === undefined
        ? {}
        : {
            output_credits_per_million:
              model.output_credits_per_million,
          }),
    })),
  });
}

function createDaemonCatalogResponse(): Response {
  return new Response(null, {
    status: 200,
    headers: {
      "x-mindcode-model-catalog-source": "daemon-cache",
    },
  });
}

export function createVexzyModelClient(
  options: VexzyModelClientOptions = {},
): VexzyModelClient {
  return new VexzyModelClient(options);
}

function validateCatalogTimestamp(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new VexzyModelClientError("invalid_response");
  }
  return value;
}

function validateTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new TypeError("Vexzy model timeout must be a non-negative number");
  }
  return timeoutMs;
}

function getClientErrorMessage(code: VexzyModelClientErrorCode): string {
  switch (code) {
    case "aborted":
      return "Vexzy model request was aborted";
    case "timeout":
      return "Vexzy model request timed out";
    case "invalid_response":
      return "Vexzy model response was invalid";
    case "network":
      return "Vexzy model request failed";
  }
}

function createCombinedSignal(
  parentSignal: AbortSignal | undefined,
  timeoutMs: number,
): CombinedSignal {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const abortFromParent = () => {
    controller.abort();
  };

  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });
  }

  if (!controller.signal.aborted && timeoutMs > 0) {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
  }

  return {
    signal: controller.signal,
    wasTimedOut: () => timedOut,
    cleanup: () => {
      if (timer !== undefined) clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abortFromParent);
    },
  };
}

async function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs <= 0) {
    if (signal.aborted) throw new VexzyModelClientError("aborted");
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timerRef: {
      id: ReturnType<typeof setTimeout> | undefined;
    } = { id: undefined };

    const cleanup = () => {
      if (timerRef.id !== undefined) clearTimeout(timerRef.id);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(new VexzyModelClientError("aborted"));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }

    timerRef.id = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
  });
}
