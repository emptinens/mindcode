import { createHash } from "node:crypto";
import {
  MODEL_CATALOG_MAX_BYTES,
  MODEL_CATALOG_MAX_FUTURE_SKEW_MS,
  MODEL_CATALOG_MAX_MODELS,
  MODEL_CATALOG_SCHEMA_VERSION,
  type ModelCatalogFactoryInput,
  type ModelCatalogGetResult,
  type ModelCatalogModel,
  type ModelCatalogPutResult,
  type ModelCatalogSnapshot,
  type ModelCatalogStatusResult,
} from "./types.js";

const MAX_ID_LENGTH = 256;
const MAX_DISPLAY_NAME_LENGTH = 512;
const MAX_STATUS_LENGTH = 128;
const MAX_DIGEST_LENGTH = 64;
const MAX_EFFORTS = 32;
const MAX_MODALITIES = 32;
const MAX_CAPABILITIES = 64;

const MAX_COLLECTION_ITEM_LENGTH = 128;
const FORBIDDEN_FIELD_NAMES = new Set([
  "raw",
  "key",
  "authorization",
  "prompt",
  "prompts",
  "response",
  "responses",
]);

export class ModelCatalogProtocolError extends Error {
  readonly code = "MODEL_CATALOG_PROTOCOL_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ModelCatalogProtocolError";
  }
}

/**
 * Normalize a provider-shaped model by projecting only the cache-safe fields.
 * Unknown provider metadata is deliberately ignored, never copied.
 */
export function normalizeModelCatalogModel(input: unknown): ModelCatalogModel {
  const source = object(input, "model");
  const model: Record<string, unknown> = {
    id: source.id,
    display_name: source.display_name ?? source.displayName,
    available: source.available,
    context_length:
      source.context_length ?? source.contextLength ?? source.context,
    efforts:
      source.efforts ??
      source.supported_reasoning_efforts ??
      source.supportedReasoningEfforts ??
      source.reasoningEfforts,
    modalities: source.modalities ?? {
      input: source.input_modalities ?? source.inputModalities,
      output: source.output_modalities ?? source.outputModalities,
    },
    capabilities:
      source.capabilities ??
      Object.fromEntries(
        ["reasoning", "tools", "vision"]
          .filter((key) => typeof source[key] === "boolean")
          .map((key) => [key, source[key]]),
      ),
  };
  if (source.status !== undefined && source.status !== null) {
    model.status = source.status;
  }
  const outputLimit =
    source.output_limit ??
    source.outputLimit ??
    source.max_output_tokens ??
    source.max_completion_tokens ??
    source.max_output;
  if (outputLimit !== undefined && outputLimit !== null) {
    model.output_limit = outputLimit;
  }
  if (
    (source.output_credits_per_million ?? source.outputCreditsPerMillion) !==
      undefined &&
    (source.output_credits_per_million ?? source.outputCreditsPerMillion) !==
      null
  ) {
    model.output_credits_per_million =
      source.output_credits_per_million ?? source.outputCreditsPerMillion;
  }
  return validateModelCatalogModel(model);
}

/** Project an arbitrary snapshot-shaped value to the keyless cache schema. */
export function normalizeModelCatalogSnapshot(
  input: unknown,
): ModelCatalogSnapshot {
  const source = object(input, "snapshot");
  const models = array(source.models, "snapshot.models").map((model) =>
    normalizeModelCatalogModel(model),
  );
  const fetchedAtMs = source.fetched_at_ms ?? source.fetchedAtMs;
  return createSnapshot(models, fetchedAtMs);
}

/**
 * Build the canonical keyless snapshot published by the VEXZY model client.
 * Provider objects are projected through the same normalizer as cache writes.
 */
export function createNormalizedModelCatalogSnapshot(
  models: ModelCatalogFactoryInput,
  fetchedAtMs?: number,
): ModelCatalogSnapshot {
  if (Array.isArray(models)) {
    return createSnapshot(
      models.map((model) => normalizeModelCatalogModel(model)),
      fetchedAtMs,
    );
  }
  const objectValue = object(models, "model catalog input");
  return createSnapshot(
    array(objectValue.models, "model catalog input.models").map((model) =>
      normalizeModelCatalogModel(model),
    ),
    objectValue.fetched_at_ms ?? objectValue.fetchedAtMs ?? fetchedAtMs,
  );
}

/** Short public alias for model clients publishing registry models. */
export const createModelCatalogSnapshot = createNormalizedModelCatalogSnapshot;

export function validateModelCatalogModel(
  input: unknown,
  context = "model",
): ModelCatalogModel {
  const source = exactObject(
    input,
    [
      "id",
      "display_name",
      "available",
      "status",
      "context_length",
      "efforts",
      "modalities",
      "capabilities",
      "output_limit",
      "output_credits_per_million",
    ],
    context,
  );
  const result = {
    id: text(source.id, `${context}.id`, MAX_ID_LENGTH),
    display_name: text(
      source.display_name,
      `${context}.display_name`,
      MAX_DISPLAY_NAME_LENGTH,
    ),
    available: booleanValue(source.available, `${context}.available`),
    context_length: positiveInteger(
      source.context_length,
      `${context}.context_length`,
    ),
    efforts: stringList(source.efforts, `${context}.efforts`, MAX_EFFORTS),
    modalities: validateModalities(source.modalities, `${context}.modalities`),
    capabilities: validateCapabilities(
      source.capabilities,
      `${context}.capabilities`,
    ),
  } as {
    id: string;
    display_name: string;
    available: boolean;
    status?: string;
    context_length: number;
    efforts: readonly string[];
    modalities: ModelCatalogModel["modalities"];
    capabilities: Readonly<Record<string, boolean>>;
    output_limit?: number;
    output_credits_per_million?: number;
  };
  if (source.status !== undefined) {
    result.status = text(source.status, `${context}.status`, MAX_STATUS_LENGTH);
  }
  if (source.output_limit !== undefined) {
    result.output_limit = positiveInteger(
      source.output_limit,
      `${context}.output_limit`,
    );
    if (result.output_limit > result.context_length) {
      throw protocol(`${context}.output_limit cannot exceed context_length`);
    }
  }
  if (source.output_credits_per_million !== undefined) {
    result.output_credits_per_million = nonNegativeFinite(
      source.output_credits_per_million,
      `${context}.output_credits_per_million`,
    );
  }
  return result;
}

export function validateModelCatalogSnapshot(
  input: unknown,
  context = "snapshot",
): ModelCatalogSnapshot {
  const source = exactObject(
    input,
    ["schema_version", "fetched_at_ms", "digest", "models"],
    context,
  );
  if (source.schema_version !== MODEL_CATALOG_SCHEMA_VERSION) {
    throw protocol(`${context}.schema_version must be 1`);
  }
  const models = array(source.models, `${context}.models`);
  if (models.length > MODEL_CATALOG_MAX_MODELS) {
    throw protocol(
      `${context}.models exceeds ${MODEL_CATALOG_MAX_MODELS} items`,
    );
  }
  const normalizedModels = models.map((model, index) =>
    validateModelCatalogModel(model, `${context}.models[${index}]`),
  );
  const ids = new Set<string>();
  for (const [index, model] of normalizedModels.entries()) {
    if (ids.has(model.id)) {
      throw protocol(`${context}.models[${index}] duplicate model id`);
    }
    ids.add(model.id);
  }
  const fetchedAtMs = nonNegativeInteger(
    source.fetched_at_ms,
    `${context}.fetched_at_ms`,
  );
  if (fetchedAtMs > Date.now() + MODEL_CATALOG_MAX_FUTURE_SKEW_MS) {
    throw protocol(`${context}.fetched_at_ms is too far in the future`);
  }
  const snapshot: ModelCatalogSnapshot = {
    schema_version: MODEL_CATALOG_SCHEMA_VERSION,
    fetched_at_ms: fetchedAtMs,
    digest: text(source.digest, `${context}.digest`, 64),
    models: normalizedModels,
  };
  if (!/^[0-9a-f]{64}$/.test(snapshot.digest)) {
    throw protocol(`${context}.digest must be lowercase hexadecimal SHA-256`);
  }
  if (snapshot.digest !== computeModelCatalogDigest(snapshot)) {
    throw protocol(`${context}.digest does not match the canonical snapshot`);
  }
  if (utf8Bytes(JSON.stringify(snapshot)) > MODEL_CATALOG_MAX_BYTES) {
    throw protocol(`normalized ${context} exceeds 1 MiB`);
  }
  return snapshot;
}

export function validateModelCatalogGetResult(
  input: unknown,
  context = "vexzy.catalog.get result",
): ModelCatalogGetResult {
  const source = exactObject(input, ["snapshot"], context);
  return {
    snapshot:
      source.snapshot === null
        ? null
        : validateModelCatalogSnapshot(source.snapshot, `${context}.snapshot`),
  };
}

export function validateModelCatalogPutResult(
  input: unknown,
  context = "vexzy.catalog.put result",
): ModelCatalogPutResult {
  const source = exactObject(input, ["stored"], context);
  return { stored: booleanValue(source.stored, `${context}.stored`) };
}

export function validateModelCatalogStatusResult(
  input: unknown,
  context = "vexzy.catalog.status result",
): ModelCatalogStatusResult {
  const source = exactObject(
    input,
    ["state", "has_snapshot", "fetched_at_ms", "digest"],
    context,
  );
  if (source.state !== "empty" && source.state !== "ready") {
    throw protocol(`${context}.state must be empty or ready`);
  }
  const result: {
    state: "empty" | "ready";
    has_snapshot: boolean;
    fetched_at_ms?: number;
    digest?: string;
  } = {
    state: source.state as "empty" | "ready",
    has_snapshot: booleanValue(source.has_snapshot, `${context}.has_snapshot`),
  };
  if (source.fetched_at_ms !== undefined) {
    result.fetched_at_ms = nonNegativeInteger(
      source.fetched_at_ms,
      `${context}.fetched_at_ms`,
    );
  }
  if (source.digest !== undefined) {
    result.digest = text(source.digest, `${context}.digest`, MAX_DIGEST_LENGTH);
    if (!/^[0-9a-f]{64}$/.test(result.digest)) {
      throw protocol(`${context}.digest must be lowercase hexadecimal SHA-256`);
    }
  }
  if (result.state === "ready") {
    if (!result.has_snapshot) {
      throw protocol(`${context} ready state requires has_snapshot=true`);
    }
    if (result.fetched_at_ms === undefined || result.digest === undefined) {
      throw protocol(
        `${context} ready state requires fetched_at_ms and digest`,
      );
    }
  }
  if (result.state === "empty") {
    if (result.has_snapshot) {
      throw protocol(`${context} empty state requires has_snapshot=false`);
    }
    if (result.fetched_at_ms !== undefined || result.digest !== undefined) {
      throw protocol(`${context} empty state forbids fetched_at_ms and digest`);
    }
  }
  return result as ModelCatalogStatusResult;
}

/** Recursively freeze only the validated, normalized graph. */
export function freezeModelCatalogSnapshot(
  snapshot: ModelCatalogSnapshot,
): ModelCatalogSnapshot {
  return deepFreeze(snapshot);
}

function createSnapshot(
  models: readonly ModelCatalogModel[],
  fetchedAtMs: unknown,
): ModelCatalogSnapshot {
  const withoutDigest = {
    schema_version: MODEL_CATALOG_SCHEMA_VERSION,
    fetched_at_ms: nonNegativeInteger(
      fetchedAtMs,
      "normalized snapshot.fetched_at_ms",
    ),
    models,
  };
  const snapshot = {
    ...withoutDigest,
    digest: computeModelCatalogDigest(withoutDigest),
  };
  return validateModelCatalogSnapshot(snapshot, "normalized snapshot");
}

export function computeModelCatalogDigest(
  value: Pick<
    ModelCatalogSnapshot,
    "schema_version" | "fetched_at_ms" | "models"
  >,
): string {
  const canonical = JSON.stringify({
    schema_version: value.schema_version,
    fetched_at_ms: value.fetched_at_ms,
    models: value.models,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateModalities(
  value: unknown,
  context: string,
): ModelCatalogModel["modalities"] {
  const source = exactObject(value, ["input", "output"], context);
  return {
    input: stringList(source.input, `${context}.input`, MAX_MODALITIES),
    output: stringList(source.output, `${context}.output`, MAX_MODALITIES),
  };
}

function validateCapabilities(
  value: unknown,
  context: string,
): Readonly<Record<string, boolean>> {
  const source = object(value, context);
  const keys = Object.keys(source).sort();
  if (keys.length > MAX_CAPABILITIES) {
    throw protocol(`${context} exceeds ${MAX_CAPABILITIES} entries`);
  }
  const result: Record<string, boolean> = {};
  for (const key of keys.sort()) {
    safeFieldName(key, `${context}.${key}`);
    result[key] = booleanValue(source[key], `${context}.${key}`);
  }
  return result;
}

function exactObject(
  value: unknown,
  allowed: readonly string[],
  context: string,
): Record<string, unknown> {
  const source = object(value, context);
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(source)) {
    safeFieldName(key, `${context}.${key}`);
    if (!allowedSet.has(key))
      throw protocol(`${context} contains unknown field`);
  }
  return source;
}

function object(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw protocol(`${context} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw protocol(`${context} must be an array`);
  return value;
}

function text(value: unknown, context: string, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw protocol(`${context} must be a non-empty string`);
  }
  if (value.length > maxLength) throw protocol(`${context} is too long`);
  if ([...value].some((character) => character.charCodeAt(0) < 0x20)) {
    throw protocol(`${context} contains control characters`);
  }
  return value;
}

function stringList(
  value: unknown,
  context: string,
  maxItems: number,
): readonly string[] {
  const values = array(value, context);
  if (values.length > maxItems) throw protocol(`${context} has too many items`);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, item] of values.entries()) {
    const normalized = text(
      item,
      `${context}[${index}]`,
      MAX_COLLECTION_ITEM_LENGTH,
    );
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function booleanValue(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") throw protocol(`${context} must be boolean`);
  return value;
}

function positiveInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw protocol(`${context} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw protocol(`${context} must be a non-negative safe integer`);
  }
  return value;
}

function nonNegativeFinite(value: unknown, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw protocol(`${context} must be a non-negative finite number`);
  }
  return value;
}

function safeFieldName(value: string, context: string): void {
  if (FORBIDDEN_FIELD_NAMES.has(value.toLowerCase())) {
    throw protocol(`${context} is not permitted in the model catalog schema`);
  }
}

function protocol(message: string): ModelCatalogProtocolError {
  return new ModelCatalogProtocolError(message);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value as Record<string, unknown>)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
