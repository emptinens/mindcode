import { createHash } from "node:crypto";

import type { BetaMessageStreamParams } from "./protocolTypes.js";
import type { VexzyMessageCreateParams } from "./messagesClient.js";

export type VexzyRequestSnapshotParams =
  | VexzyMessageCreateParams
  | BetaMessageStreamParams;

export interface VexzyRequestSnapshotLimits {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
  readonly maxBytes?: number;
}

export const DEFAULT_VEXZY_REQUEST_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 128,
  maxNodes: 100_000,
  maxBytes: 64 * 1024 * 1024,
} satisfies Required<VexzyRequestSnapshotLimits>);

export type VexzyRequestSnapshotErrorCode =
  | "invalid_root"
  | "cycle"
  | "prototype"
  | "accessor"
  | "symbol"
  | "unsupported"
  | "non_finite_number"
  | "credential_field"
  | "max_depth"
  | "max_nodes"
  | "max_bytes";

export class VexzyRequestSnapshotError extends Error {
  readonly code: VexzyRequestSnapshotErrorCode;
  readonly path: string;
  readonly limit: number | undefined;
  readonly actual: number | undefined;

  constructor(
    code: VexzyRequestSnapshotErrorCode,
    path: string,
    limit?: number,
    actual?: number,
  ) {
    super(snapshotErrorMessage(code));
    this.name = "VexzyRequestSnapshotError";
    this.code = code;
    this.path = path;
    this.limit = limit;
    this.actual = actual;
  }
}

export interface VexzyRequestSnapshot<
  T extends VexzyRequestSnapshotParams = VexzyRequestSnapshotParams,
> {
  readonly digest: string;
  readonly byteLength: number;
  readonly nodeCount: number;
  readonly params: ReadonlyDeep<T>;
  materialize(): T;
}

type ReadonlyDeep<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly ReadonlyDeep<U>[]
    : T extends object
      ? { readonly [K in keyof T]: ReadonlyDeep<T[K]> }
      : T;

interface ResolvedLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

interface BuildResult<T> {
  readonly value: T;
  readonly digest: string;
  readonly byteLength: number;
  readonly nodeCount: number;
}

const textEncoder = new TextEncoder();

export function createVexzyRequestSnapshot<
  T extends VexzyRequestSnapshotParams,
>(params: T, limits: VexzyRequestSnapshotLimits = {}): VexzyRequestSnapshot<T> {
  const resolved = resolveLimits(limits);
  assertRequestRoot(params);
  const built = buildSnapshot(params, resolved);
  deepFreeze(built.value);

  const frozenParams = built.value as ReadonlyDeep<T>;
  const snapshot: VexzyRequestSnapshot<T> = {
    digest: built.digest,
    byteLength: built.byteLength,
    nodeCount: built.nodeCount,
    params: frozenParams,
    materialize: () => cloneValue(frozenParams, resolved, false) as T,
  };

  return Object.freeze(snapshot);
}

export function materializeVexzyRequestSnapshot<
  T extends VexzyRequestSnapshotParams,
>(snapshot: VexzyRequestSnapshot<T>): T {
  return snapshot.materialize();
}

export function digestVexzyRequestParams<T extends VexzyRequestSnapshotParams>(
  params: T,
  limits: VexzyRequestSnapshotLimits = {},
): string {
  return createVexzyRequestSnapshot(params, limits).digest;
}

function buildSnapshot<T>(params: T, limits: ResolvedLimits): BuildResult<T> {
  const state: CloneState = {
    limits,
    nodes: 0,
    bytes: 0,
    active: new WeakSet<object>(),
    hash: createHash("sha256"),
  };

  const value = cloneValue(params, state, true);
  return {
    value,
    digest: state.hash.digest("hex"),
    byteLength: state.bytes,
    nodeCount: state.nodes,
  };
}

interface CloneState {
  readonly limits: ResolvedLimits;
  nodes: number;
  bytes: number;
  readonly active: WeakSet<object>;
  readonly hash: ReturnType<typeof createHash>;
}

function cloneValue<T>(
  value: T,
  stateOrLimits: CloneState | ResolvedLimits,
  digest: boolean,
  path = "$",
  depth = 0,
): T {
  const state = isCloneState(stateOrLimits)
    ? stateOrLimits
    : createCloneState(stateOrLimits);
  const valueType = typeof value;

  checkDepth(state, depth, path);
  countNode(state, path);

  if (value === null) {
    writeCanonical(state, digest, "null");
    return value;
  }
  if (valueType === "undefined") {
    writeCanonical(state, digest, "undefined");
    return value;
  }
  if (valueType === "string") {
    writeCanonical(state, digest, `string:${JSON.stringify(value)}`);
    return value;
  }
  if (valueType === "boolean") {
    writeCanonical(state, digest, value ? "true" : "false");
    return value;
  }
  if (valueType === "number") {
    if (!Number.isFinite(value)) {
      throw new VexzyRequestSnapshotError("non_finite_number", path);
    }
    writeCanonical(
      state,
      digest,
      Object.is(value, -0) ? "number:-0" : `number:${String(value)}`,
    );
    return value;
  }
  if (
    valueType === "bigint" ||
    valueType === "symbol" ||
    valueType === "function"
  ) {
    throw new VexzyRequestSnapshotError("unsupported", path);
  }

  const objectValue = value as object;
  if (state.active.has(objectValue)) {
    throw new VexzyRequestSnapshotError("cycle", path);
  }

  state.active.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return cloneArray(
        objectValue as readonly unknown[],
        state,
        digest,
        path,
        depth,
      ) as T;
    }
    return cloneObject(objectValue, state, digest, path, depth) as T;
  } finally {
    state.active.delete(objectValue);
  }
}

function cloneArray(
  value: readonly unknown[],
  state: CloneState,
  digest: boolean,
  path: string,
  depth: number,
): unknown[] {
  assertPrototype(value, Array.prototype, path);
  const descriptors = safeDescriptors(value, path);
  const symbols = safeSymbols(value, path);
  if (symbols.length > 0) {
    throw new VexzyRequestSnapshotError("symbol", path);
  }

  const lengthDescriptor = descriptors.length;
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.get !== undefined ||
    lengthDescriptor.set !== undefined ||
    typeof lengthDescriptor.value !== "number"
  ) {
    throw new VexzyRequestSnapshotError("accessor", `${path}.length`);
  }
  if (value.length > state.limits.maxNodes - state.nodes) {
    throw new VexzyRequestSnapshotError(
      "max_nodes",
      path,
      state.limits.maxNodes,
      state.nodes + value.length,
    );
  }

  const keys = Object.keys(value);
  for (const key of keys) {
    if (!isArrayIndex(key, value.length)) {
      throw new VexzyRequestSnapshotError("unsupported", `${path}.${key}`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      throw new VexzyRequestSnapshotError("accessor", `${path}.${key}`);
    }
    assertDataDescriptor(descriptor, `${path}[${key}]`);
  }
  for (const key of safeNames(value, path)) {
    if (
      key !== "length" &&
      !Object.prototype.propertyIsEnumerable.call(value, key)
    ) {
      throw new VexzyRequestSnapshotError("unsupported", `${path}.${key}`);
    }
  }

  writeCanonical(state, digest, `array:${value.length}[`);
  const result = new Array<unknown>(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      countNode(state, `${path}[${index}]`);
      writeCanonical(state, digest, "hole");
      continue;
    }
    const child = cloneValue(
      descriptor.value,
      state,
      digest,
      `${path}[${index}]`,
      depth + 1,
    );
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  writeCanonical(state, digest, "]");
  return result;
}

function cloneObject(
  value: object,
  state: CloneState,
  digest: boolean,
  path: string,
  depth: number,
): Record<string, unknown> {
  const prototype = safePrototype(value, path);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new VexzyRequestSnapshotError("prototype", path);
  }

  const descriptors = safeDescriptors(value, path);
  const symbols = safeSymbols(value, path);
  if (symbols.length > 0) {
    throw new VexzyRequestSnapshotError("symbol", path);
  }
  const keys = Object.keys(value).sort();
  for (const key of keys) {
    if (
      path === "$" &&
      (key.toLowerCase() === "headers" || isCredentialField(key))
    ) {
      throw new VexzyRequestSnapshotError("credential_field", `${path}.${key}`);
    }
    const descriptor = descriptors[key];
    if (descriptor === undefined) {
      throw new VexzyRequestSnapshotError("accessor", `${path}.${key}`);
    }
    assertDataDescriptor(descriptor, `${path}.${key}`);
  }
  for (const key of safeNames(value, path)) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) {
      throw new VexzyRequestSnapshotError("unsupported", `${path}.${key}`);
    }
  }

  writeCanonical(state, digest, "object{");
  const result = Object.create(prototype) as Record<string, unknown>;
  for (const key of keys) {
    writeCanonical(state, digest, `key:${JSON.stringify(key)}=`);
    const child = cloneValue(
      descriptors[key]?.value,
      state,
      digest,
      `${path}.${key}`,
      depth + 1,
    );
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: child,
      writable: true,
    });
  }
  writeCanonical(state, digest, "}");
  return result;
}

function assertDataDescriptor(
  descriptor: PropertyDescriptor,
  path: string,
): asserts descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new VexzyRequestSnapshotError("accessor", path);
  }
  if (!("value" in descriptor)) {
    throw new VexzyRequestSnapshotError("accessor", path);
  }
}

function safeDescriptors(value: object, path: string): PropertyDescriptorMap {
  try {
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new VexzyRequestSnapshotError("unsupported", path);
  }
}

function safeNames(value: object, path: string): string[] {
  try {
    return Object.getOwnPropertyNames(value);
  } catch {
    throw new VexzyRequestSnapshotError("unsupported", path);
  }
}

function safeSymbols(value: object, path: string): symbol[] {
  try {
    return Object.getOwnPropertySymbols(value);
  } catch {
    throw new VexzyRequestSnapshotError("symbol", path);
  }
}

function safePrototype(value: object, path: string): object | null {
  try {
    return Object.getPrototypeOf(value) as object | null;
  } catch {
    throw new VexzyRequestSnapshotError("prototype", path);
  }
}

function assertPrototype(value: object, expected: object, path: string): void {
  if (safePrototype(value, path) !== expected) {
    throw new VexzyRequestSnapshotError("prototype", path);
  }
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  Object.freeze(value);
}

function writeCanonical(
  state: CloneState,
  enabled: boolean,
  value: string,
): void {
  if (!enabled) return;
  const bytes = textEncoder.encode(value).byteLength;
  const next = state.bytes + bytes;
  if (next > state.limits.maxBytes) {
    throw new VexzyRequestSnapshotError(
      "max_bytes",
      "$",
      state.limits.maxBytes,
      next,
    );
  }
  state.bytes = next;
  state.hash.update(value, "utf8");
}

function countNode(state: CloneState, path: string): void {
  state.nodes += 1;
  if (state.nodes > state.limits.maxNodes) {
    throw new VexzyRequestSnapshotError(
      "max_nodes",
      path,
      state.limits.maxNodes,
      state.nodes,
    );
  }
}

function checkDepth(state: CloneState, depth: number, path: string): void {
  if (depth > state.limits.maxDepth) {
    throw new VexzyRequestSnapshotError(
      "max_depth",
      path,
      state.limits.maxDepth,
      depth,
    );
  }
}

function resolveLimits(input: VexzyRequestSnapshotLimits): ResolvedLimits {
  const result = {
    maxDepth: input.maxDepth ?? DEFAULT_VEXZY_REQUEST_SNAPSHOT_LIMITS.maxDepth,
    maxNodes: input.maxNodes ?? DEFAULT_VEXZY_REQUEST_SNAPSHOT_LIMITS.maxNodes,
    maxBytes: input.maxBytes ?? DEFAULT_VEXZY_REQUEST_SNAPSHOT_LIMITS.maxBytes,
  };
  for (const [name, value] of Object.entries(result)) {
    if (!Number.isSafeInteger(value) || value < (name === "maxDepth" ? 0 : 1)) {
      throw new VexzyRequestSnapshotError("unsupported", `$.__limits.${name}`);
    }
  }
  return result;
}

function assertRequestRoot(value: unknown): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new VexzyRequestSnapshotError("invalid_root", "$");
  }
  const prototype = safePrototype(value, "$");
  if (prototype !== Object.prototype && prototype !== null) {
    throw new VexzyRequestSnapshotError("prototype", "$");
  }
}

function createCloneState(limits: ResolvedLimits): CloneState {
  return {
    limits,
    nodes: 0,
    bytes: 0,
    active: new WeakSet<object>(),
    hash: createHash("sha256"),
  };
}

function isCloneState(value: CloneState | ResolvedLimits): value is CloneState {
  return "hash" in value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return (
    Number.isSafeInteger(index) &&
    index >= 0 &&
    index < length &&
    String(index) === key
  );
}

function isCredentialField(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll("_", "-");
  const compact = normalized.replaceAll("-", "");
  return (
    normalized === "authorization" ||
    normalized === "proxy-authorization" ||
    normalized === "x-api-key" ||
    normalized === "api-key" ||
    compact.includes("authorization") ||
    compact.includes("apikey") ||
    compact.includes("accesskey") ||
    compact.includes("secretkey") ||
    compact.includes("clientsecret")
  );
}

function snapshotErrorMessage(code: VexzyRequestSnapshotErrorCode): string {
  switch (code) {
    case "max_depth":
      return "VEXZY request snapshot exceeds the maximum depth";
    case "max_nodes":
      return "VEXZY request snapshot exceeds the maximum node count";
    case "max_bytes":
      return "VEXZY request snapshot exceeds the maximum byte size";
    case "credential_field":
      return "VEXZY request snapshot contains a credential-shaped field";
    case "cycle":
      return "VEXZY request snapshot cannot contain cycles";
    case "prototype":
      return "VEXZY request snapshot accepts only plain data prototypes";
    case "accessor":
      return "VEXZY request snapshot rejects accessor properties";
    case "symbol":
      return "VEXZY request snapshot rejects symbol properties";
    case "non_finite_number":
      return "VEXZY request snapshot accepts only finite numbers";
    case "invalid_root":
      return "VEXZY request snapshot root must be a plain object";
    case "unsupported":
      return "VEXZY request snapshot contains unsupported data";
  }
}
