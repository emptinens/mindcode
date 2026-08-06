import type { ToolUseContext } from "../../Tool.js";
import { getSessionId } from "../../bootstrap/state.js";
import {
  type InProcessWorkerLease,
  acquireInProcessWorker,
  bindInProcessWorker,
  decideInProcessWorkerSpawn,
  isWarmInProcessDecision,
} from "../../runtime/workerPool/spawnRouting.js";
import { getCwd } from "../../utils/cwd.js";
import { logForDebugging } from "../../utils/debug.js";
import type { WorkerRuntime } from "../../utils/swarm/backends/types.js";
import type { InProcessSpawnOutput } from "../../utils/swarm/spawnInProcess.js";

export {
  acquireInProcessWorker,
  bindInProcessWorker,
  decideInProcessWorkerSpawn,
  isWarmInProcessDecision,
};

export type WorkerPoolSpawnInput = {
  cwd?: string;
  writeOverlap?: boolean;
  hasWriteOverlap?: boolean;
  overlap?: boolean;
  isolation?: "shared" | "isolated" | "worktree";
};

export function createWorkerPoolSpawnRequest(
  input: WorkerPoolSpawnInput,
  workerRuntime: WorkerRuntime,
) {
  return {
    projectId: input.cwd || getCwd(),
    sessionId: String(getSessionId()),
    model: workerRuntime.model,
    effort: workerRuntime.effort,
    writeOverlap: input.writeOverlap,
    hasWriteOverlap: input.hasWriteOverlap,
    overlap: input.overlap,
    isolation: input.isolation,
  } as const;
}

export function bindWorkerPoolLeaseToLifecycle(
  taskId: string,
  context: ToolUseContext,
  lease: InProcessWorkerLease,
  abortSignal: AbortSignal,
): void {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    abortSignal.removeEventListener("abort", onAbort);
    void lease.release().catch((error) => {
      logForDebugging(
        `[handleSpawnInProcess] WorkerPool reset failed for ${taskId}: ${String(error)}`,
      );
    });
  };
  const onAbort = () => release();
  const lifecycleCallback = () => {
    queueMicrotask(() => {
      const task = context.getAppState().tasks[taskId];
      if (!task || task.status !== "running") {
        release();
        return;
      }

      // The runner clears callbacks after each idle turn. Re-attach this
      // lifecycle callback without polling; terminal completion invokes it
      // again and the microtask sees the committed terminal state.
      context.setAppState((previous) => {
        const current = previous.tasks[taskId];
        if (!current || current.type !== "in_process_teammate") return previous;
        return {
          ...previous,
          tasks: {
            ...previous.tasks,
            [taskId]: {
              ...current,
              onIdleCallbacks: [
                ...(current.onIdleCallbacks ?? []),
                lifecycleCallback,
              ],
            },
          },
        };
      });
    });
  };

  abortSignal.addEventListener("abort", onAbort, { once: true });
  context.setAppState((previous) => {
    const task = previous.tasks[taskId];
    if (!task || task.type !== "in_process_teammate") return previous;
    return {
      ...previous,
      tasks: {
        ...previous.tasks,
        [taskId]: {
          ...task,
          onIdleCallbacks: [...(task.onIdleCallbacks ?? []), lifecycleCallback],
        },
      },
    };
  });
}

type WarmWorkerDecision = Extract<
  ReturnType<typeof decideInProcessWorkerSpawn>,
  { kind: "warm" }
>;

export async function acquireSpawnedInProcessWorker(
  input: WorkerPoolSpawnInput,
  workerRuntime: WorkerRuntime,
  decision: WarmWorkerDecision,
  spawn: () => Promise<InProcessSpawnOutput>,
): Promise<{
  result: InProcessSpawnOutput;
  lease: InProcessWorkerLease;
}> {
  if (!isWarmInProcessDecision(decision)) {
    throw new Error("WorkerPool route changed before in-process spawn");
  }
  const lease = await acquireInProcessWorker(
    createWorkerPoolSpawnRequest(input, workerRuntime),
  );
  try {
    const result = await spawn();
    if (
      !result.success ||
      !result.taskId ||
      !result.teammateContext ||
      !result.abortController
    ) {
      await lease.release().catch(() => false);
    }
    return { result, lease };
  } catch (error) {
    await lease.release().catch(() => false);
    throw error;
  }
}

export function bindSpawnedInProcessWorker(
  lease: InProcessWorkerLease,
  taskId: string,
  teammateContext: NonNullable<InProcessSpawnOutput["teammateContext"]>,
  context: ToolUseContext,
  abortSignal: AbortSignal,
): void {
  bindInProcessWorker(lease, taskId, {
    context: teammateContext,
    tools: context.options.tools,
  });
  bindWorkerPoolLeaseToLifecycle(taskId, context, lease, abortSignal);
}
