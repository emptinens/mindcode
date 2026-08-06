import { redactSecrets } from "../../utils/secretRedaction.js";
import { StreamingDagError } from "./errors.js";
import { DEFAULT_STREAMING_DAG_LIMITS } from "./types.js";
import type {
  StreamingDagApplyResult,
  StreamingDagCoordinatorOptions,
  StreamingDagCoordinatorPhase,
  StreamingDagEvent,
  StreamingDagLimits,
  StreamingDagSnapshot,
  StreamingDagSnapshotTask,
  StreamingDagState,
  StreamingDagTask,
  StreamingDagTaskState,
  StreamingDagTaskStatus,
} from "./types.js";
import { STREAMING_DAG_TASK_STATUSES } from "./types.js";

type InternalTask<TTask, TResult> = StreamingDagTaskState<TTask, TResult> & {
  dispatched: boolean;
};

type ActiveTask = {
  controller: AbortController;
};

type NormalizedSnapshot<TTask, TResult> = {
  tasks: Map<string, InternalTask<TTask, TResult>>;
  graphVersion: number;
};

const MAX_EXTERNAL_REASON_LENGTH = 512;

export class StreamingDagCoordinator<TTask = unknown, TResult = unknown> {
  private readonly executor: StreamingDagCoordinatorOptions<
    TTask,
    TResult
  >["executor"];
  private readonly onTaskStateChange: StreamingDagCoordinatorOptions<
    TTask,
    TResult
  >["onTaskStateChange"];
  private readonly onResyncRequired: StreamingDagCoordinatorOptions<
    TTask,
    TResult
  >["onResyncRequired"];
  private readonly limits: StreamingDagLimits;
  private readonly tasks = new Map<string, InternalTask<TTask, TResult>>();
  private readonly active = new Map<string, ActiveTask>();
  private readonly dispatched = new Set<string>();
  private externalAbortListener?: () => void;
  private externalSignal?: AbortSignal;
  private phaseValue: StreamingDagCoordinatorPhase = "awaiting_snapshot";
  private leaderConnectedValue = true;
  private sequenceValue = -1;
  private graphVersionValue: number | null = null;

  constructor(options: StreamingDagCoordinatorOptions<TTask, TResult>) {
    this.executor = options.executor;
    this.onTaskStateChange = options.onTaskStateChange;
    this.onResyncRequired = options.onResyncRequired;
    this.limits = normalizeLimits(options.limits);

    if (options.signal) {
      const signal = options.signal;
      const listener = () => this.cancel(signal.reason);
      this.externalSignal = signal;
      this.externalAbortListener = listener;
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    }
  }

  getState(): StreamingDagState<TTask, TResult> {
    return {
      phase: this.phaseValue,
      leaderConnected: this.leaderConnectedValue,
      sequence: this.sequenceValue,
      graphVersion: this.graphVersionValue,
      tasks: [...this.tasks.values()].map((task) => publicTask(task)),
    };
  }

  applySnapshot(
    snapshot: StreamingDagSnapshot<TTask, TResult>,
  ): StreamingDagApplyResult {
    if (this.phaseValue === "cancelled") {
      throw new StreamingDagError(
        "CANCELLED",
        "The coordinator has been cancelled",
      );
    }
    if (
      this.phaseValue !== "awaiting_snapshot" &&
      this.phaseValue !== "resync_required"
    ) {
      throw new StreamingDagError(
        "RESYNC_REQUIRED",
        "A snapshot can only replace an initial or invalidated stream",
      );
    }
    return this.installSnapshot(snapshot);
  }

  reconnect(
    snapshot: StreamingDagSnapshot<TTask, TResult>,
  ): StreamingDagApplyResult {
    if (this.phaseValue === "cancelled") {
      throw new StreamingDagError(
        "CANCELLED",
        "The coordinator has been cancelled",
      );
    }
    return this.installSnapshot(snapshot);
  }

  applyEvent(
    event: StreamingDagEvent<TTask, TResult>,
  ): StreamingDagApplyResult {
    if (this.phaseValue === "cancelled") {
      throw new StreamingDagError(
        "CANCELLED",
        "The coordinator has been cancelled",
      );
    }
    if (this.phaseValue === "awaiting_snapshot") {
      throw new StreamingDagError(
        "NOT_READY",
        "A snapshot is required before events can be applied",
      );
    }
    if (this.phaseValue === "resync_required") {
      return {
        kind: "resync_required",
        reason: "already_required",
        expectedSequence: this.sequenceValue + 1,
        receivedSequence: event.sequence,
      };
    }
    if (!this.leaderConnectedValue && event.kind === "task_created") {
      return { kind: "rejected", reason: "leader_disconnected" };
    }
    validateEvent(event, this.limits);
    const expectedSequence = this.sequenceValue + 1;
    if (event.sequence !== expectedSequence) {
      const result: Extract<
        StreamingDagApplyResult,
        { kind: "resync_required" }
      > = {
        kind: "resync_required",
        reason: event.sequence <= this.sequenceValue ? "duplicate" : "gap",
        expectedSequence,
        receivedSequence: event.sequence,
      };
      this.phaseValue = "resync_required";
      this.onResyncRequired?.(result);
      return result;
    }

    this.applyValidatedEvent(event);
    this.sequenceValue = event.sequence;
    const scheduled = this.pump();
    return { kind: "applied", sequence: event.sequence, scheduled };
  }

  createTask(task: StreamingDagTask<TTask>): StreamingDagApplyResult {
    if (!this.leaderConnectedValue) {
      throw new StreamingDagError(
        "LEADER_DISCONNECTED",
        "New task creation is disabled while the leader is disconnected",
      );
    }
    return this.applyEvent({
      kind: "task_created",
      sequence: this.sequenceValue + 1,
      task,
    });
  }

  disconnectLeader(): void {
    if (this.phaseValue === "cancelled") return;
    this.leaderConnectedValue = false;
  }

  cancel(reason?: unknown): void {
    if (this.phaseValue === "cancelled") return;
    const sanitizedReason = sanitizeExternalReason(reason, "Cancelled");
    this.phaseValue = "cancelled";
    for (const [taskId, active] of this.active) {
      this.active.delete(taskId);
      active.controller.abort(sanitizedReason);
    }
    for (const task of this.tasks.values()) {
      if (
        task.status === "pending" ||
        task.status === "ready" ||
        task.status === "running"
      ) {
        task.status = "cancelled";
        task.error = sanitizedReason;
        this.notify(task);
      }
    }
  }

  dispose(): void {
    if (this.externalSignal && this.externalAbortListener) {
      this.externalSignal.removeEventListener(
        "abort",
        this.externalAbortListener,
      );
    }
    this.cancel();
  }

  private installSnapshot(
    snapshot: StreamingDagSnapshot<TTask, TResult>,
  ): StreamingDagApplyResult {
    const normalized = normalizeSnapshot(snapshot, this.limits);
    if (snapshot.sequence < this.sequenceValue) {
      invalidSnapshot("sequence must be monotonic");
    }
    if (
      this.graphVersionValue !== null &&
      snapshot.graphVersion < this.graphVersionValue
    ) {
      invalidSnapshot("graphVersion must be monotonic");
    }
    const previousTasks = new Map(this.tasks);
    const retained = new Set<string>();

    // A reconnect snapshot is authoritative. Only preserve local runtime
    // state for a task that is still present and not terminal in the source
    // snapshot. Missing dispatched tasks are stale and are removed.
    this.tasks.clear();
    for (const [taskId, incoming] of normalized.tasks) {
      const previous = previousTasks.get(taskId);
      if (previous?.dispatched && !isTerminalStatus(incoming.status)) {
        this.tasks.set(taskId, previous);
        retained.add(taskId);
      } else {
        this.tasks.set(taskId, incoming);
        if (previous?.dispatched) this.stopActive(taskId, "reconnect snapshot");
      }
    }
    for (const previous of previousTasks.values()) {
      if (previous.dispatched && !retained.has(previous.id)) {
        this.stopActive(previous.id, "reconnect snapshot");
      }
    }
    for (const taskId of this.dispatched) {
      if (!this.tasks.has(taskId)) this.dispatched.delete(taskId);
    }

    this.propagateBlocks();
    this.sequenceValue = snapshot.sequence;
    this.graphVersionValue = normalized.graphVersion;
    this.phaseValue = "ready";
    this.leaderConnectedValue = true;
    for (const task of this.tasks.values()) this.notify(task);
    const scheduled = this.pump();
    return { kind: "applied", sequence: snapshot.sequence, scheduled };
  }

  private applyValidatedEvent(event: StreamingDagEvent<TTask, TResult>): void {
    switch (event.kind) {
      case "task_created": {
        if (this.tasks.has(event.task.id)) {
          throw new StreamingDagError(
            "INVALID_EVENT",
            "The event creates an existing task",
          );
        }
        if (this.tasks.size >= this.limits.maxTasks) {
          invalidEvent("task count exceeds the configured limit");
        }
        const task = internalTask<TTask, TResult>(event.task, "pending");
        const candidate = new Map<string, InternalTask<TTask, TResult>>(
          this.tasks,
        );
        candidate.set(task.id, task);
        if (totalDependencies(candidate) > this.limits.maxTotalDependencies) {
          invalidEvent("total dependencies exceed the configured limit");
        }
        assertAcyclic(candidate, true, "INVALID_EVENT");
        this.tasks.set(task.id, task);
        this.notify(task);
        break;
      }
      case "task_succeeded":
        this.finishFromEvent(event.taskId, "succeeded", event.result);
        break;
      case "task_failed":
        this.finishFromEvent(event.taskId, "failed", undefined, event.error);
        break;
      case "task_cancelled":
        this.finishFromEvent(
          event.taskId,
          "cancelled",
          undefined,
          event.reason,
        );
        break;
    }
  }

  private finishFromEvent(
    taskId: string,
    status: "succeeded" | "failed" | "cancelled",
    result?: TResult,
    error?: unknown,
  ): void {
    const task = this.requireTask(taskId);
    if (isTerminalStatus(task.status)) return;

    const sanitizedError =
      status === "succeeded"
        ? undefined
        : sanitizeExternalReason(
            error,
            status === "cancelled" ? "Cancelled" : "Task failed",
          );
    const active = this.active.get(taskId);
    if (active) {
      this.active.delete(taskId);
      active.controller.abort(sanitizedError);
    }
    task.status = status;
    if (status === "succeeded") {
      task.result = result;
      task.error = undefined;
    } else {
      task.result = undefined;
      task.error = sanitizedError;
    }
    this.notify(task);
    this.propagateBlocks();
  }

  private stopActive(taskId: string, reason: string): void {
    const active = this.active.get(taskId);
    if (!active) return;
    this.active.delete(taskId);
    active.controller.abort(reason);
  }

  private pump(): string[] {
    if (this.phaseValue === "cancelled") return [];
    const scheduled: string[] = [];
    for (const task of this.tasks.values()) {
      if (!this.isReady(task)) continue;
      task.status = "running";
      task.dispatched = true;
      this.dispatched.add(task.id);
      const active: ActiveTask = { controller: new AbortController() };
      this.active.set(task.id, active);
      scheduled.push(task.id);
      this.notify(task);
      void this.run(task, active);
    }
    return scheduled;
  }

  private isReady(task: InternalTask<TTask, TResult>): boolean {
    if (this.phaseValue !== "ready") return false;
    if (task.dispatched || this.dispatched.has(task.id)) return false;
    if (task.status !== "pending" && task.status !== "ready") return false;
    return task.dependencies.every(
      (dependencyId) => this.tasks.get(dependencyId)?.status === "succeeded",
    );
  }

  private async run(
    task: InternalTask<TTask, TResult>,
    active: ActiveTask,
  ): Promise<void> {
    try {
      const dependencies = new Map<string, TResult>();
      for (const dependencyId of task.dependencies) {
        const dependency = this.tasks.get(dependencyId);
        if (dependency?.status === "succeeded") {
          dependencies.set(dependencyId, dependency.result as TResult);
        }
      }
      const result = await this.executor(task, {
        signal: active.controller.signal,
        dependencies,
      });
      if (this.active.get(task.id) !== active) return;
      this.active.delete(task.id);
      if (this.phaseValue === "cancelled" || task.status !== "running") return;
      task.status = "succeeded";
      task.result = result;
      this.notify(task);
      this.pump();
    } catch (error) {
      if (this.active.get(task.id) !== active) return;
      this.active.delete(task.id);
      if (this.phaseValue === "cancelled") return;
      if (task.status !== "running") return;
      task.status = "failed";
      task.error = sanitizeExternalReason(error, "Task failed");
      this.notify(task);
      this.propagateBlocks();
      this.pump();
    }
  }

  private propagateBlocks(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of this.tasks.values()) {
        if (task.status !== "pending" && task.status !== "ready") continue;
        const blocked = task.dependencies.some((dependencyId) => {
          const dependency = this.tasks.get(dependencyId);
          return (
            dependency?.status === "failed" ||
            dependency?.status === "blocked" ||
            dependency?.status === "cancelled"
          );
        });
        if (blocked) {
          task.status = "blocked";
          changed = true;
          this.notify(task);
        }
      }
    }
  }

  private requireTask(taskId: string): InternalTask<TTask, TResult> {
    const task = this.tasks.get(taskId);
    if (!task) {
      throw new StreamingDagError(
        "TASK_NOT_FOUND",
        "The event references an unknown task",
      );
    }
    return task;
  }

  private notify(task: InternalTask<TTask, TResult>): void {
    this.onTaskStateChange?.(publicTask(task));
  }
}

export function createStreamingDagCoordinator<
  TTask = unknown,
  TResult = unknown,
>(
  options: StreamingDagCoordinatorOptions<TTask, TResult>,
): StreamingDagCoordinator<TTask, TResult> {
  return new StreamingDagCoordinator(options);
}

function internalTask<TTask, TResult>(
  task: StreamingDagSnapshotTask<TTask, TResult>,
  status: StreamingDagTaskStatus,
): InternalTask<TTask, TResult> {
  return {
    id: task.id,
    dependencies: [...task.dependencies],
    payload: task.payload,
    status,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined
      ? { error: sanitizeExternalReason(task.error, "Task failed") }
      : {}),
    dispatched: false,
  };
}

function publicTask<TTask, TResult>(
  task: InternalTask<TTask, TResult>,
): StreamingDagTaskState<TTask, TResult> {
  return {
    id: task.id,
    dependencies: [...task.dependencies],
    payload: task.payload,
    status: task.status,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}

function normalizeSnapshot<TTask, TResult>(
  snapshot: StreamingDagSnapshot<TTask, TResult>,
  limits: StreamingDagLimits,
): NormalizedSnapshot<TTask, TResult> {
  validateSnapshot(snapshot, limits);
  const tasks = new Map<string, InternalTask<TTask, TResult>>();
  for (const task of snapshot.tasks) {
    const status =
      task.status === "ready" ? "pending" : (task.status ?? "pending");
    tasks.set(task.id, internalTask(task, status));
  }
  assertAcyclic(tasks, false);
  return { tasks, graphVersion: snapshot.graphVersion };
}

function validateSnapshot<TTask, TResult>(
  snapshot: StreamingDagSnapshot<TTask, TResult>,
  limits: StreamingDagLimits,
): void {
  if (typeof snapshot !== "object" || snapshot === null) {
    invalidSnapshot("snapshot");
  }
  if (!isSafeNonNegativeInteger(snapshot.sequence)) {
    invalidSnapshot("sequence");
  }
  if (!isSafeNonNegativeInteger(snapshot.graphVersion)) {
    invalidSnapshot("graphVersion");
  }
  if (!Array.isArray(snapshot.tasks)) invalidSnapshot("tasks");
  if (snapshot.tasks.length > limits.maxTasks) {
    invalidSnapshot("task count exceeds the configured limit");
  }
  const ids = new Set<string>();
  let totalDependencies = 0;
  for (const task of snapshot.tasks) {
    validateTask(task, "snapshot task", "INVALID_SNAPSHOT", limits);
    if (ids.has(task.id)) invalidSnapshot("duplicate task id");
    ids.add(task.id);
    totalDependencies += task.dependencies.length;
    if (task.status && !STREAMING_DAG_TASK_STATUSES.includes(task.status)) {
      invalidSnapshot("task status");
    }
  }
  if (totalDependencies > limits.maxTotalDependencies) {
    invalidSnapshot("total dependencies exceed the configured limit");
  }
  for (const task of snapshot.tasks) {
    for (const dependencyId of task.dependencies) {
      if (!ids.has(dependencyId)) invalidSnapshot("missing dependency");
    }
  }
}

function validateEvent<TTask, TResult>(
  event: StreamingDagEvent<TTask, TResult>,
  limits: StreamingDagLimits,
): void {
  if (typeof event !== "object" || event === null) {
    invalidEvent("event");
  }
  if (!isSafeNonNegativeInteger(event.sequence)) invalidEvent("sequence");
  if (
    event.kind !== "task_created" &&
    event.kind !== "task_succeeded" &&
    event.kind !== "task_failed" &&
    event.kind !== "task_cancelled"
  ) {
    invalidEvent("kind");
  }
  if (event.kind === "task_created") {
    validateTask(event.task, "event task", "INVALID_EVENT", limits);
  } else if (
    typeof event.taskId !== "string" ||
    event.taskId.length === 0 ||
    event.taskId.length > limits.maxTaskIdLength
  ) {
    invalidEvent("taskId");
  }
}

function validateTask<TTask>(
  task: StreamingDagTask<TTask>,
  context: string,
  code: "INVALID_SNAPSHOT" | "INVALID_EVENT" = "INVALID_SNAPSHOT",
  limits: StreamingDagLimits = DEFAULT_STREAMING_DAG_LIMITS,
): void {
  if (
    typeof task !== "object" ||
    task === null ||
    typeof task.id !== "string" ||
    task.id.length === 0 ||
    !Array.isArray(task.dependencies) ||
    task.dependencies.some(
      (dependencyId) =>
        typeof dependencyId !== "string" || dependencyId.length === 0,
    )
  ) {
    throw new StreamingDagError(code, `${context} is invalid`);
  }
  if (task.id.length > limits.maxTaskIdLength) {
    throw new StreamingDagError(
      code,
      `${context} id exceeds the configured length limit`,
    );
  }
  if (task.dependencies.length > limits.maxDependenciesPerTask) {
    throw new StreamingDagError(
      code,
      `${context} exceeds the configured dependency limit`,
    );
  }
  if (new Set(task.dependencies).size !== task.dependencies.length) {
    throw new StreamingDagError(code, `${context} has duplicate dependencies`);
  }
  if (task.dependencies.includes(task.id)) {
    throw new StreamingDagError(code, `${context} depends on itself`);
  }
}

function assertAcyclic<TTask, TResult>(
  tasks: Map<string, InternalTask<TTask, TResult>>,
  allowMissing: boolean,
  code: "INVALID_SNAPSHOT" | "INVALID_EVENT" = "INVALID_SNAPSHOT",
): void {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (taskId: string): void => {
    if (visited.has(taskId)) return;
    if (visiting.has(taskId)) {
      throw new StreamingDagError(
        code,
        "The streaming DAG contains a dependency cycle",
      );
    }
    const task = tasks.get(taskId);
    if (!task) return;
    visiting.add(taskId);
    for (const dependencyId of task.dependencies) {
      if (!tasks.has(dependencyId) && !allowMissing) {
        invalidSnapshot("missing dependency");
      }
      visit(dependencyId);
    }
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const taskId of tasks.keys()) visit(taskId);
}

function totalDependencies<TTask, TResult>(
  tasks: Map<string, InternalTask<TTask, TResult>>,
): number {
  let total = 0;
  for (const task of tasks.values()) total += task.dependencies.length;
  return total;
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function normalizeLimits(
  limits: Partial<StreamingDagLimits> | undefined,
): StreamingDagLimits {
  const normalized = {
    ...DEFAULT_STREAMING_DAG_LIMITS,
    ...limits,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new StreamingDagError(
        "INVALID_SNAPSHOT",
        `Invalid streaming DAG limit: ${name}`,
      );
    }
  }
  return normalized;
}

function isTerminalStatus(status: StreamingDagTaskStatus): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "blocked"
  );
}

function sanitizeExternalReason(value: unknown, fallback: string): string {
  let text: string | undefined;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = value.message || value.name;
  } else if (value !== null && typeof value === "object") {
    const candidate = value as { message?: unknown; name?: unknown };
    if (typeof candidate.message === "string") text = candidate.message;
    else if (typeof candidate.name === "string") text = candidate.name;
  } else if (value !== undefined && value !== null) {
    text = String(value);
  }

  const normalized = redactSecrets(
    [...(text ?? fallback)]
      .map((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f ? " " : character;
      })
      .join("")
      .replace(/\s+/g, " ")
      .trim(),
  );
  if (normalized.length === 0) return fallback;
  return normalized.length > MAX_EXTERNAL_REASON_LENGTH
    ? `${normalized.slice(0, MAX_EXTERNAL_REASON_LENGTH - 1)}…`
    : normalized;
}

function invalidSnapshot(field: string): never {
  throw new StreamingDagError(
    "INVALID_SNAPSHOT",
    `Invalid streaming DAG snapshot field: ${field}`,
  );
}

function invalidEvent(field: string): never {
  throw new StreamingDagError(
    "INVALID_EVENT",
    `Invalid streaming DAG event field: ${field}`,
  );
}
