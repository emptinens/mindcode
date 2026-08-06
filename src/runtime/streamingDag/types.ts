export const STREAMING_DAG_TASK_STATUSES = [
  "pending",
  "ready",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
] as const;

export type StreamingDagTaskStatus =
  (typeof STREAMING_DAG_TASK_STATUSES)[number];

export type StreamingDagTask<TTask = unknown> = {
  id: string;
  dependencies: readonly string[];
  payload: TTask;
};

export type StreamingDagSnapshotTask<
  TTask = unknown,
  TResult = unknown,
> = StreamingDagTask<TTask> & {
  status?: StreamingDagTaskStatus;
  result?: TResult;
  error?: unknown;
};

export type StreamingDagSnapshot<TTask = unknown, TResult = unknown> = {
  sequence: number;
  graphVersion: number;
  tasks: readonly StreamingDagSnapshotTask<TTask, TResult>[];
};

export type StreamingDagEvent<TTask = unknown, TResult = unknown> =
  | {
      kind: "task_created";
      sequence: number;
      task: StreamingDagTask<TTask>;
    }
  | {
      kind: "task_succeeded";
      sequence: number;
      taskId: string;
      result?: TResult;
    }
  | {
      kind: "task_failed";
      sequence: number;
      taskId: string;
      error: unknown;
    }
  | {
      kind: "task_cancelled";
      sequence: number;
      taskId: string;
      reason?: unknown;
    };

export type StreamingDagExecutionContext<TResult = unknown> = {
  signal: AbortSignal;
  dependencies: ReadonlyMap<string, TResult>;
};

export type StreamingDagExecutor<TTask = unknown, TResult = unknown> = (
  task: StreamingDagTask<TTask>,
  context: StreamingDagExecutionContext<TResult>,
) => TResult | PromiseLike<TResult>;

export type StreamingDagTaskState<
  TTask = unknown,
  TResult = unknown,
> = StreamingDagSnapshotTask<TTask, TResult> & {
  status: StreamingDagTaskStatus;
};

export type StreamingDagCoordinatorPhase =
  | "awaiting_snapshot"
  | "ready"
  | "resync_required"
  | "cancelled";

export type StreamingDagState<TTask = unknown, TResult = unknown> = {
  phase: StreamingDagCoordinatorPhase;
  leaderConnected: boolean;
  sequence: number;
  graphVersion: number | null;
  tasks: readonly StreamingDagTaskState<TTask, TResult>[];
};

export type StreamingDagApplyResult =
  | {
      kind: "applied";
      sequence: number;
      scheduled: readonly string[];
    }
  | {
      kind: "resync_required";
      reason: "gap" | "duplicate" | "already_required";
      expectedSequence: number;
      receivedSequence: number;
    }
  | {
      kind: "rejected";
      reason: "leader_disconnected";
    };

export type StreamingDagCoordinatorOptions<
  TTask = unknown,
  TResult = unknown,
> = {
  executor: StreamingDagExecutor<TTask, TResult>;
  signal?: AbortSignal;
  limits?: Partial<StreamingDagLimits>;
  onTaskStateChange?: (task: StreamingDagTaskState<TTask, TResult>) => void;
  onResyncRequired?: (
    result: Extract<StreamingDagApplyResult, { kind: "resync_required" }>,
  ) => void;
};

export type StreamingDagLimits = {
  maxTasks: number;
  maxTaskIdLength: number;
  maxDependenciesPerTask: number;
  maxTotalDependencies: number;
};

export const DEFAULT_STREAMING_DAG_LIMITS: Readonly<StreamingDagLimits> = {
  maxTasks: 1_024,
  maxTaskIdLength: 256,
  maxDependenciesPerTask: 128,
  maxTotalDependencies: 16_384,
};
