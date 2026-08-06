import type {
  ClaimRequest,
  ClaimResult,
  RecoveryResult,
  RouteResult,
  RouteTaskInput,
  TaskGraphSnapshot,
  TaskLease,
  TaskRecord,
  TaskUpdate,
} from "../../tasks/graph/types.js";
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
import type {
  DaemonCallResult,
  DaemonRequestOptions,
} from "../daemon/types.js";
import { normalizeTaskGraphError } from "./errors.js";
import {
  type TaskGraphClaimParams,
  type TaskGraphDaemonTransport,
  type TaskGraphLeaseParams,
  type TaskGraphListParams,
  type TaskGraphReleaseParams,
  type TaskGraphRequestOptions,
  type TaskGraphRouteParams,
  type TaskGraphRouteUpdateParams,
  type TaskGraphWatchEvent,
  type TaskGraphWatchParams,
  type TaskGraphWatchResult,
  serializeNow,
  validateClaimResult,
  validateLeaseResult,
  validateListDependentsResult,
  validateListResult,
  validateReadResult,
  validateRecoveryResult,
  validateRouteResult,
  validateSnapshot,
  validateUpdateResult,
  validateWatchChunk,
  validateWatchResult,
} from "./protocol.js";

export type TaskGraphFallback<T> = () => T | Promise<T>;

export class TaskGraphDaemonClient {
  private readonly transport: TaskGraphDaemonTransport;

  constructor(transport: TaskGraphDaemonTransport = getDaemonManager()) {
    if (!transport.request && !transport.requestWithFallback) {
      throw new TypeError(
        "Task graph transport must expose request or requestWithFallback",
      );
    }
    this.transport = transport;
  }

  route(
    task: RouteTaskInput,
    mode?: "block" | "reject",
    options?: TaskGraphRequestOptions,
  ): Promise<RouteResult>;
  route(
    params: TaskGraphRouteParams,
    options?: TaskGraphRequestOptions,
  ): Promise<RouteResult>;
  async route(
    taskOrParams: RouteTaskInput | TaskGraphRouteParams,
    modeOrOptions?: "block" | "reject" | TaskGraphRequestOptions,
    requestOptions: TaskGraphRequestOptions = {},
  ): Promise<RouteResult> {
    const { params, options } = routeParams(
      taskOrParams,
      modeOrOptions,
      requestOptions,
    );
    return this.call("task_graph.route", params, validateRouteResult, options);
  }

  async routeUpdate(
    params: TaskGraphRouteUpdateParams,
    options?: TaskGraphRequestOptions,
  ): Promise<RouteResult> {
    return this.call(
      "task_graph.route_update",
      compact(params),
      validateRouteResult,
      options,
    );
  }

  async read(
    taskId: string,
    options?: TaskGraphRequestOptions,
  ): Promise<{ task: TaskRecord | null }> {
    return this.call(
      "task_graph.read",
      { task_id: taskId },
      validateReadResult,
      options,
    );
  }

  async list(
    params: TaskGraphListParams = {},
    options?: TaskGraphRequestOptions,
  ): Promise<{ tasks: TaskRecord[] }> {
    return this.call(
      "task_graph.list",
      compact(params),
      validateListResult,
      options,
    );
  }

  async listDependents(
    taskId: string,
    options?: TaskGraphRequestOptions,
  ): Promise<{ tasks: TaskRecord[] }> {
    return this.call(
      "task_graph.list_dependents",
      { task_id: taskId },
      validateListDependentsResult,
      options,
    );
  }

  async claim(
    request: TaskGraphClaimParams,
    options?: TaskGraphRequestOptions,
  ): Promise<ClaimResult>;
  async claim(
    taskId: string,
    request: ClaimRequest,
    options?: TaskGraphRequestOptions,
  ): Promise<ClaimResult>;
  async claim(
    taskOrRequest: string | TaskGraphClaimParams,
    requestOrOptions?: ClaimRequest | TaskGraphRequestOptions,
    requestOptions: TaskGraphRequestOptions = {},
  ): Promise<ClaimResult> {
    const params =
      typeof taskOrRequest === "string"
        ? this.claimParams(taskOrRequest, requestOrOptions as ClaimRequest)
        : this.claimParamsFromWire(taskOrRequest);
    const options =
      typeof taskOrRequest === "string"
        ? requestOptions
        : (requestOrOptions as TaskGraphRequestOptions | undefined);
    return this.call("task_graph.claim", params, validateClaimResult, options);
  }

  async update(
    taskId: string,
    patch: TaskUpdate,
    expectedVersion?: number,
    options?: TaskGraphRequestOptions,
  ): Promise<{ task: TaskRecord }> {
    return this.call(
      "task_graph.update",
      compact({ task_id: taskId, patch, expected_version: expectedVersion }),
      validateUpdateResult,
      options,
    );
  }

  async renewLease(
    leaseId: string,
    params: Omit<TaskGraphLeaseParams, "lease_id"> = {},
    options?: TaskGraphRequestOptions,
  ): Promise<{ lease: TaskLease | null }> {
    return this.call(
      "task_graph.renew_lease",
      compact({
        lease_id: leaseId,
        owner: params.owner,
        ttl_ms: params.ttl_ms,
        now: serializeNow(params.now),
      }),
      validateLeaseResult,
      options,
    );
  }

  async releaseLease(
    leaseId: string,
    params: Omit<TaskGraphReleaseParams, "lease_id"> = {},
    options?: TaskGraphRequestOptions,
  ): Promise<{ lease: TaskLease | null }> {
    return this.call(
      "task_graph.release_lease",
      compact({
        lease_id: leaseId,
        owner: params.owner,
        now: serializeNow(params.now),
      }),
      validateLeaseResult,
      options,
    );
  }

  async recover(
    now?: string | Date,
    options?: TaskGraphRequestOptions,
  ): Promise<RecoveryResult> {
    return this.call(
      "task_graph.recover",
      compact({ now: serializeNow(now) }),
      validateRecoveryResult,
      options,
    );
  }

  async snapshot(
    options?: TaskGraphRequestOptions,
  ): Promise<TaskGraphSnapshot> {
    return this.call("task_graph.snapshot", {}, validateSnapshot, options);
  }

  async watch(
    params: TaskGraphWatchParams,
    onEvent: (event: TaskGraphWatchEvent) => void | Promise<void>,
    options: Omit<TaskGraphRequestOptions, "onChunk"> = {},
  ): Promise<TaskGraphWatchResult> {
    let eventChain = Promise.resolve();
    const result = await this.call(
      "task_graph.watch",
      serializeWatchParams(params),
      validateWatchResult,
      {
        ...options,
        onChunk: (data, sequence) => {
          const chunk = validateWatchChunk(data);
          eventChain = eventChain.then(() => onEvent({ ...chunk, sequence }));
          return eventChain;
        },
      },
    );
    await eventChain;
    return result;
  }

  routeWithFallback(
    task: RouteTaskInput,
    fallback: TaskGraphFallback<RouteResult>,
    mode?: "block" | "reject",
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<RouteResult>>;
  routeWithFallback(
    params: TaskGraphRouteParams,
    fallback: TaskGraphFallback<RouteResult>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<RouteResult>>;
  async routeWithFallback(
    taskOrParams: RouteTaskInput | TaskGraphRouteParams,
    fallback: TaskGraphFallback<RouteResult>,
    modeOrOptions?: "block" | "reject" | TaskGraphRequestOptions,
    requestOptions: TaskGraphRequestOptions = {},
  ): Promise<DaemonCallResult<RouteResult>> {
    const { params, options } = routeParams(
      taskOrParams,
      modeOrOptions,
      requestOptions,
    );
    return this.callWithFallback(
      "task_graph.route",
      params,
      fallback,
      validateRouteResult,
      options,
    );
  }

  routeUpdateWithFallback(
    params: TaskGraphRouteUpdateParams,
    fallback: TaskGraphFallback<RouteResult>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<RouteResult>> {
    return this.callWithFallback(
      "task_graph.route_update",
      compact(params),
      fallback,
      validateRouteResult,
      options,
    );
  }

  readWithFallback(
    taskId: string,
    fallback: TaskGraphFallback<{ task: TaskRecord | null }>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ task: TaskRecord | null }>> {
    return this.callWithFallback(
      "task_graph.read",
      { task_id: taskId },
      fallback,
      validateReadResult,
      options,
    );
  }

  listWithFallback(
    params: TaskGraphListParams,
    fallback: TaskGraphFallback<{ tasks: TaskRecord[] }>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ tasks: TaskRecord[] }>> {
    return this.callWithFallback(
      "task_graph.list",
      compact(params),
      fallback,
      validateListResult,
      options,
    );
  }

  listDependentsWithFallback(
    taskId: string,
    fallback: TaskGraphFallback<{ tasks: TaskRecord[] }>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ tasks: TaskRecord[] }>> {
    return this.callWithFallback(
      "task_graph.list_dependents",
      { task_id: taskId },
      fallback,
      validateListDependentsResult,
      options,
    );
  }

  claimWithFallback(
    request: TaskGraphClaimParams,
    fallback: TaskGraphFallback<ClaimResult>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<ClaimResult>>;
  claimWithFallback(
    taskId: string,
    request: ClaimRequest,
    fallback: TaskGraphFallback<ClaimResult>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<ClaimResult>>;
  claimWithFallback(
    taskOrId: string | TaskGraphClaimParams,
    requestOrFallback: ClaimRequest | TaskGraphFallback<ClaimResult>,
    fallbackOrOptions?:
      | TaskGraphFallback<ClaimResult>
      | TaskGraphRequestOptions,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<ClaimResult>> {
    const params =
      typeof taskOrId === "string"
        ? this.claimParams(taskOrId, requestOrFallback as ClaimRequest)
        : this.claimParamsFromWire(taskOrId);
    const fallback =
      typeof taskOrId === "string"
        ? (fallbackOrOptions as TaskGraphFallback<ClaimResult>)
        : (requestOrFallback as TaskGraphFallback<ClaimResult>);
    const requestOptions =
      typeof taskOrId === "string"
        ? options
        : (fallbackOrOptions as TaskGraphRequestOptions | undefined);
    return this.callWithFallback(
      "task_graph.claim",
      params,
      fallback,
      validateClaimResult,
      requestOptions,
    );
  }

  updateWithFallback(
    taskId: string,
    patch: TaskUpdate,
    fallback: TaskGraphFallback<{ task: TaskRecord }>,
    expectedVersion?: number,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ task: TaskRecord }>> {
    return this.callWithFallback(
      "task_graph.update",
      compact({ task_id: taskId, patch, expected_version: expectedVersion }),
      fallback,
      validateUpdateResult,
      options,
    );
  }

  renewLeaseWithFallback(
    leaseId: string,
    params: Omit<TaskGraphLeaseParams, "lease_id">,
    fallback: TaskGraphFallback<{ lease: TaskLease | null }>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ lease: TaskLease | null }>> {
    return this.callWithFallback(
      "task_graph.renew_lease",
      compact({
        lease_id: leaseId,
        owner: params.owner,
        ttl_ms: params.ttl_ms,
        now: serializeNow(params.now),
      }),
      fallback,
      validateLeaseResult,
      options,
    );
  }

  releaseLeaseWithFallback(
    leaseId: string,
    params: Omit<TaskGraphReleaseParams, "lease_id">,
    fallback: TaskGraphFallback<{ lease: TaskLease | null }>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<{ lease: TaskLease | null }>> {
    return this.callWithFallback(
      "task_graph.release_lease",
      compact({
        lease_id: leaseId,
        owner: params.owner,
        now: serializeNow(params.now),
      }),
      fallback,
      validateLeaseResult,
      options,
    );
  }

  recoverWithFallback(
    now: string | Date | undefined,
    fallback: TaskGraphFallback<RecoveryResult>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<RecoveryResult>> {
    return this.callWithFallback(
      "task_graph.recover",
      compact({ now: serializeNow(now) }),
      fallback,
      validateRecoveryResult,
      options,
    );
  }

  snapshotWithFallback(
    fallback: TaskGraphFallback<TaskGraphSnapshot>,
    options?: TaskGraphRequestOptions,
  ): Promise<DaemonCallResult<TaskGraphSnapshot>> {
    return this.callWithFallback(
      "task_graph.snapshot",
      {},
      fallback,
      validateSnapshot,
      options,
    );
  }

  private claimParams(
    taskId: string,
    request: ClaimRequest,
  ): TaskGraphClaimParams {
    const now = serializeNow(request.now);
    return compact({
      task_id: taskId,
      owner: request.owner,
      lease_id: request.lease_id ?? request.leaseId,
      ttl_ms: request.ttl_ms ?? request.ttlMs,
      expected_version: request.expected_version ?? request.expectedVersion,
      now,
    }) as TaskGraphClaimParams;
  }

  private claimParamsFromWire(
    request: TaskGraphClaimParams,
  ): TaskGraphClaimParams {
    return compact({
      task_id: request.task_id,
      owner: request.owner,
      lease_id: request.lease_id,
      ttl_ms: request.ttl_ms,
      expected_version: request.expected_version,
      now: serializeNow(request.now),
    }) as TaskGraphClaimParams;
  }

  private async call<T>(
    method: string,
    params: unknown,
    validator: (value: unknown) => T,
    options?: DaemonRequestOptions,
  ): Promise<T> {
    try {
      if (this.transport.request) {
        return validator(
          await this.transport.request<unknown>(method, params, options),
        );
      }
      if (this.transport.requestWithFallback) {
        const marker = Object.freeze({ taskGraphFallbackMarker: true });
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
      throw normalizeTaskGraphError(error);
    }
  }

  private async callWithFallback<T>(
    method: string,
    params: unknown,
    fallback: TaskGraphFallback<T>,
    validator: (value: unknown) => T,
    options?: DaemonRequestOptions,
  ): Promise<DaemonCallResult<T>> {
    try {
      if (this.transport.requestWithFallback) {
        // The generic daemon manager cannot know whether retrying a logical
        // operation is safe.  Give it a sentinel instead of the real
        // fallback, then decide here using TaskGraph operation semantics.
        const marker = Object.freeze({ taskGraphFallbackMarker: true });
        const result = await this.transport.requestWithFallback<unknown>(
          method,
          params,
          marker,
          options,
        );
        if (result.source === "fallback" && result.value === marker) {
          const error =
            result.error ??
            new DaemonClientError(
              "DAEMON_UNAVAILABLE",
              "Daemon request was unavailable",
            );
          if (!canFallbackOperation(method, error)) {
            throw error;
          }
          return {
            source: "fallback",
            value: validator(await fallback()),
            reason: classifyDaemonFallback(error),
            error,
          };
        }
        return {
          ...result,
          value: validator(result.value),
        } as DaemonCallResult<T>;
      }
      if (!this.transport.request)
        throw new DaemonClientError(
          "DAEMON_REQUEST_UNAVAILABLE",
          "Daemon transport does not expose request",
        );
      try {
        return {
          source: "daemon",
          value: validator(
            await this.transport.request<unknown>(method, params, options),
          ),
        };
      } catch (error) {
        if (!canFallbackOperation(method, error)) {
          throw error;
        }
        return {
          source: "fallback",
          value: validator(await fallback()),
          reason: classifyDaemonFallback(error),
          error,
        };
      }
    } catch (error) {
      throw normalizeTaskGraphError(error);
    }
  }
}

function isMutationMethod(method: string): boolean {
  return (
    method === "task_graph.route" ||
    method === "task_graph.route_update" ||
    method === "task_graph.claim" ||
    method === "task_graph.update" ||
    method === "task_graph.renew_lease" ||
    method === "task_graph.release_lease" ||
    method === "task_graph.recover"
  );
}

function canFallbackMutation(error: unknown): boolean {
  if (error instanceof DaemonDisabledError) return true;
  if (error instanceof DaemonDisconnectedError) return false;
  if (error instanceof DaemonTimeoutError) {
    return error.kind === "connect" || error.kind === "handshake";
  }
  if (error instanceof DaemonCancelledError) return false;
  if (error instanceof DaemonRemoteError) return false;
  if (error instanceof Error && error.name === "DaemonProtocolError")
    return false;
  if (error instanceof Error && error.name === "TaskGraphProtocolError")
    return false;
  if (error instanceof DaemonClientError) {
    return (
      error.code === "DAEMON_REQUEST_UNAVAILABLE" ||
      error.code === "DAEMON_UNAVAILABLE"
    );
  }
  return false;
}

function canFallbackRead(error: unknown): boolean {
  if (error instanceof DaemonCancelledError) return false;
  if (error instanceof DaemonRemoteError) return false;
  if (error instanceof Error && error.name === "DaemonProtocolError")
    return false;
  if (error instanceof Error && error.name === "TaskGraphProtocolError")
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
  // An arbitrary Error can be a programming bug or a protocol/validation
  // defect. Only explicit availability classes are eligible for fallback.
  return false;
}

function canFallbackOperation(method: string, error: unknown): boolean {
  return isMutationMethod(method)
    ? canFallbackMutation(error)
    : canFallbackRead(error);
}

function routeParams(
  taskOrParams: RouteTaskInput | TaskGraphRouteParams,
  modeOrOptions: "block" | "reject" | TaskGraphRequestOptions | undefined,
  requestOptions: TaskGraphRequestOptions,
): { params: TaskGraphRouteParams; options: TaskGraphRequestOptions } {
  if (isRouteParams(taskOrParams)) {
    return {
      params: taskOrParams,
      options: isRequestOptions(modeOrOptions) ? modeOrOptions : requestOptions,
    };
  }
  const mode = typeof modeOrOptions === "string" ? modeOrOptions : undefined;
  return {
    params: compact({ task: taskOrParams, mode }) as TaskGraphRouteParams,
    options: typeof modeOrOptions === "object" ? modeOrOptions : requestOptions,
  };
}

function isRouteParams(
  value: RouteTaskInput | TaskGraphRouteParams,
): value is TaskGraphRouteParams {
  return (
    Object.prototype.hasOwnProperty.call(value, "task") &&
    typeof (value as TaskGraphRouteParams).task === "object"
  );
}

function isRequestOptions(value: unknown): value is TaskGraphRequestOptions {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
}

function serializeWatchParams(
  params: TaskGraphWatchParams,
): TaskGraphWatchParams {
  const afterVersion = optionalSafeInteger(
    params.after_version,
    "after_version",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const pollIntervalMs = optionalSafeInteger(
    params.poll_interval_ms,
    "poll_interval_ms",
    10,
    1_000,
  );
  const idleTimeoutMs = optionalSafeInteger(
    params.idle_timeout_ms,
    "idle_timeout_ms",
    100,
    120_000,
  );
  return compact({
    after_version: afterVersion,
    poll_interval_ms: pollIntervalMs,
    idle_timeout_ms: idleTimeoutMs,
  });
}

function optionalSafeInteger(
  value: number | undefined,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(
      `${name} must be a safe integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}
