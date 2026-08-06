import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";

export const MODEL_CATALOG_SCHEMA_VERSION = 1 as const;
export const MODEL_CATALOG_MAX_MODELS = 1_024 as const;
export const MODEL_CATALOG_MAX_BYTES = 1_048_576 as const;
export const MODEL_CATALOG_MAX_FUTURE_SKEW_MS = 300_000 as const;
export const MODEL_CATALOG_GET_METHOD = "vexzy.catalog.get" as const;
export const MODEL_CATALOG_PUT_METHOD = "vexzy.catalog.put" as const;
export const MODEL_CATALOG_STATUS_METHOD = "vexzy.catalog.status" as const;
export const MODEL_CATALOG_METHODS = [
  MODEL_CATALOG_GET_METHOD,
  MODEL_CATALOG_PUT_METHOD,
  MODEL_CATALOG_STATUS_METHOD,
] as const;

export type ModelCatalogRequestOptions = DaemonRequestOptions;

/** The only model metadata that may cross the daemon cache boundary. */
export type ModelCatalogModel = {
  readonly id: string;
  readonly display_name: string;
  readonly available: boolean;
  readonly status?: string;
  readonly context_length: number;
  readonly efforts: readonly string[];
  readonly modalities: {
    readonly input: readonly string[];
    readonly output: readonly string[];
  };
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly output_limit?: number;
  readonly output_credits_per_million?: number;
};

export type ModelCatalogSnapshot = {
  readonly schema_version: typeof MODEL_CATALOG_SCHEMA_VERSION;
  readonly fetched_at_ms: number;
  /** Lowercase hexadecimal SHA-256 of the canonical payload without digest. */
  readonly digest: string;
  readonly models: readonly ModelCatalogModel[];
};

export type ModelCatalogGetParams = Record<never, never>;
export type ModelCatalogPutParams = {
  readonly snapshot: ModelCatalogSnapshot;
};
export type ModelCatalogStatusParams = Record<never, never>;

export type ModelCatalogGetResult = {
  readonly snapshot: ModelCatalogSnapshot | null;
};

export type ModelCatalogPutResult = {
  readonly stored: boolean;
};

export type ModelCatalogCacheState = "empty" | "ready";

export type ModelCatalogStatusResult = {
  readonly state: ModelCatalogCacheState;
  readonly has_snapshot: boolean;
  readonly fetched_at_ms?: number;
  readonly digest?: string;
};

export type ModelCatalogDaemonTransport = {
  request?: <T>(
    method: string,
    params?: unknown,
    options?: ModelCatalogRequestOptions,
  ) => Promise<T>;
  requestWithFallback?: <T>(
    method: string,
    params: unknown,
    fallback: T | (() => T | Promise<T>),
    options?: ModelCatalogRequestOptions,
  ) => Promise<DaemonCallResult<T>>;
};

export type ModelCatalogFallback<T> = () => T | Promise<T>;

export type ModelCatalogFactoryInput =
  | readonly unknown[]
  | {
      readonly models: readonly unknown[];
      readonly fetched_at_ms?: number;
      readonly fetchedAtMs?: number;
    };
