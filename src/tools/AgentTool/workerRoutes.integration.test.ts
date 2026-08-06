import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ["PreToolUse"] as const });
mock.module("src/entrypoints/agentSdkTypes.js", agentSdkTypesMock);
mock.module(
  new URL("../../entrypoints/agentSdkTypes.ts", import.meta.url).pathname,
  agentSdkTypesMock,
);
mock.module("src/entrypoints/sdk/runtimeTypes.js", () => ({}));
mock.module(
  new URL("../../entrypoints/sdk/runtimeTypes.ts", import.meta.url).pathname,
  () => ({}),
);

const configDirectory = mkdtempSync("/tmp/mindcode-worker-routes-");
const previousConfigDirectory = process.env.MINDCODE_CONFIG_DIR;
process.env.MINDCODE_CONFIG_DIR = configDirectory;

const { TaskGraph } = await import("../../tasks/graph/taskGraph.js");
const { createTestWorkerTaskGraph } = await import(
  "../../runtime/taskGraph/workerGraph.js"
);
const { acquireWorkerExecution } = await import("./workerLifecycle.js");
const {
  buildWorkerReport,
  deriveWorkerReportId,
  isWorkerReportCompletionEligible,
  persistValidatedWorkerReport,
  serializeWorkerReport,
} = await import("./workerReport.js");
const { resolveWorkerRuntime, applyWorkerRuntimeToAppState } = await import(
  "../../utils/swarm/backends/types.js"
);
type WorkerEffort = import("../../utils/swarm/backends/types.js").WorkerEffort;
const { AdaptiveSwarmConcurrencyPolicy, SWARM_EFFORT_WEIGHTS } = await import(
  "../../utils/swarm/concurrencyPolicy.js"
);
const { buildWorkerTeamReport, buildWorkerTeamReportFromMessages } =
  await import("../../utils/swarm/workerTeamReport.js");
const { buildWorkerReportInstruction } = await import("./workerReport.js");
// Fork construction is tested through its exported helper with only its
// runtime seams mocked. All mock keys are repository-relative/current paths;
// no legacy checkout path is addressable from this test.
mock.module(
  new URL("../../bootstrap/state.ts", import.meta.url).pathname,
  () => ({
    getIsNonInteractiveSession: () => false,
  }),
);
mock.module(
  new URL("../../coordinator/coordinatorMode.ts", import.meta.url).pathname,
  () => ({ isCoordinatorMode: () => false }),
);
mock.module(new URL("../../utils/debug.ts", import.meta.url).pathname, () => ({
  logForDebugging: () => undefined,
}));
mock.module(
  new URL("../../utils/messages.ts", import.meta.url).pathname,
  () => ({
    createUserMessage: ({ content }: { content: unknown }) => ({
      type: "user",
      uuid: "fork-user",
      message: { role: "user", content },
    }),
  }),
);
const { buildForkedMessages, FORK_AGENT } = await import("./forkSubagent.js");
const { configureVexzyModelCatalog, resetVexzyModelCatalog } = await import(
  "../../services/api/vexzy/modelCatalog.js"
);
const { createVexzyModelRegistry } = await import(
  "../../services/api/vexzy/modelRegistry.js"
);
const workerRegistry = createVexzyModelRegistry({
  object: "list",
  data: [
    {
      id: "gpt-5.6-luna",
      object: "model",
      owned_by: "vexzy",
      display_name: "GPT-5.6 Luna",
      available: true,
      context_length: 1_100_000,
      supported_reasoning_efforts: [
        "none",
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ],
      input_modalities: ["text"],
      output_modalities: ["text"],
      capabilities: { reasoning: true, tools: true, vision: false },
    },
  ],
});

beforeAll(async () => {
  const catalog = configureVexzyModelCatalog({
    getModels: async () => workerRegistry,
    refresh: async () => workerRegistry,
    getSnapshot: () => undefined,
  });
  await catalog.load();
});

type RouteName =
  | "AgentTool foreground"
  | "AgentTool background"
  | "fork"
  | "resume"
  | "in-process"
  | "tmux"
  | "iTerm2";

const temporaryDirectories: string[] = [];
type TaskGraphInstance = InstanceType<typeof TaskGraph>;
const openGraphs: TaskGraphInstance[] = [];

function createGraph(): TaskGraphInstance {
  const directory = mkdtempSync("/tmp/mindcode-worker-route-graph-");
  temporaryDirectories.push(directory);
  const graph = new TaskGraph({ databasePath: join(directory, "tasks.db") });
  openGraphs.push(graph);
  return graph;
}

function candidateReport(input: {
  taskId: string;
  runId: string;
  workerId: string;
  effort: WorkerEffort;
}): string {
  return JSON.stringify({
    schema_version: "worker-report/1",
    task_id: input.taskId,
    run_id: input.runId,
    worker_id: input.workerId,
    // The runtime owns this field and replaces the model's value.
    report_id: "0".repeat(64),
    model: "gpt-5.6-luna",
    effort_used: input.effort,
    policy_epoch: 0,
    policy_digest: "0".repeat(64),
    status: "completed",
    summary: `Validated ${input.taskId}`,
    changed_files: [],
    evidence: [
      {
        id: `evidence-${input.taskId}`,
        type: "test",
        command: "synthetic lifecycle contract",
        exit_code: 0,
      },
    ],
    tokens_used: 999999,
    validation: { verdict: "pass" },
    blockers: [],
  });
}

async function admitReportAndComplete(
  route: RouteName,
  effort: WorkerEffort,
): Promise<void> {
  const runtime = resolveWorkerRuntime(effort);
  expect(runtime).toEqual({ model: "gpt-5.6-luna", effort });

  const graph = createGraph();
  const scheduler = new AdaptiveSwarmConcurrencyPolicy({ budget: 8 });
  const taskId = `route-${route.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  const runId = `${taskId}-run`;
  const workerId = `${taskId}-worker`;
  const execution = await acquireWorkerExecution(
    {
      taskId,
      owner: workerId,
      schedulerScope: `contract-${route}`,
      effort: runtime.effort,
      policyEpoch: 0,
      policyDigest: "0".repeat(64),
      writeSet: [`src/${taskId}.ts`],
    },
    {
      graph: createTestWorkerTaskGraph(graph),
      acquireSchedulerLease: (scope, selectedEffort, signal) =>
        scheduler.acquire(scope, { effort: selectedEffort, signal }),
    },
  );

  expect(execution.effort).toBe(effort);
  expect(scheduler.snapshot().activeWeight).toBe(SWARM_EFFORT_WEIGHTS[effort]);
  expect(graph.requireTask(taskId)).toMatchObject({
    status: "running",
    owner: workerId,
  });

  const report = buildWorkerReport({
    taskId,
    runId,
    workerId,
    status: "completed",
    finalText: candidateReport({ taskId, runId, workerId, effort }),
    tokensUsed: 17,
    effortUsed: runtime.effort,
    policyEpoch: 0,
    policyDigest: "0".repeat(64),
  });
  const events: string[] = [];
  let settlement: Promise<void> | undefined;
  let serialized: string | undefined;
  const accepted = persistValidatedWorkerReport(
    { workerReport: report },
    {
      persist: (result) => {
        events.push("persist");
        serialized = serializeWorkerReport(result.workerReport);
      },
      complete: (result) => {
        events.push("complete");
        settlement = execution.complete({
          reportId: result.workerReport.report_id,
          policyEpoch: result.workerReport.policy_epoch,
          policyDigest: result.workerReport.policy_digest,
        });
      },
      reject: () => {
        events.push("reject");
        settlement = execution.fail();
      },
    },
    { policyEpoch: 0, policyDigest: "0".repeat(64) },
  );

  expect(accepted).toBe(true);
  expect(events).toEqual(["persist", "complete"]);
  await settlement;
  expect(serialized).toContain("worker-report/1");
  expect(serialized).not.toContain("synthetic worker transcript");
  expect(graph.requireTask(taskId)).toMatchObject({
    status: "completed",
    lease_id: null,
    report_id: report.report_id,
  });
  expect(scheduler.snapshot()).toMatchObject({
    activeWorkers: 0,
    activeWeight: 0,
  });
}

type MockPaneBoundary = {
  type: "tmux" | "iterm2";
  spawn: (command: string) => Promise<void>;
  kill: () => Promise<void>;
};

function fakePaneBoundary(
  type: "tmux" | "iterm2",
  sentCommands: string[],
  killed: string[],
): MockPaneBoundary {
  return {
    type,
    spawn: async (command) => {
      // This is the mocked backend boundary: no tmux/iTerm executable is
      // invoked by this contract test.
      sentCommands.push(command);
    },
    kill: async () => {
      killed.push(type);
    },
  };
}

afterEach(() => {
  for (const graph of openGraphs.splice(0)) graph.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

afterAll(async () => {
  resetVexzyModelCatalog();
  await Bun.sleep(50);
  if (previousConfigDirectory === undefined) {
    process.env.MINDCODE_CONFIG_DIR = undefined;
  } else {
    process.env.MINDCODE_CONFIG_DIR = previousConfigDirectory;
  }
  rmSync(configDirectory, { recursive: true, force: true });
});

describe("Worker route lifecycle integration contract", () => {
  test("foreground, background, fork, resume, and in-process routes use canonical Luna admission and report-only completion", async () => {
    for (const [route, effort] of [
      ["AgentTool foreground", "low"],
      ["AgentTool background", "high"],
      ["fork", "medium"],
      ["resume", "xhigh"],
      ["in-process", "max"],
    ] as const) {
      const runtime = resolveWorkerRuntime(effort);
      const projected = applyWorkerRuntimeToAppState(
        { effortValue: "max" },
        runtime,
      );
      expect(projected.effortValue).toBe(effort);
      expect(buildWorkerReportInstruction(`route-${route}`, effort)).toContain(
        `"effort_used":"${effort}"`,
      );
    }

    // Fork admission keeps the inherited conversation outside the Leader
    // state while still using the same canonical Worker runtime/report gate.
    const forkDirective = "continue the delegated work";
    const forkMessages = buildForkedMessages(forkDirective, {
      type: "assistant",
      uuid: "fork-parent",
      message: {
        id: "fork-parent",
        type: "message",
        role: "assistant",
        model: "gpt-5.6-sol",
        content: [
          {
            type: "tool_use",
            id: "fork-tool-use",
            name: "Agent",
            input: { prompt: forkDirective },
          },
        ],
      },
    } as never);
    expect(forkMessages).toHaveLength(2);
    expect(JSON.stringify(forkMessages[1])).toContain(forkDirective);
    expect(FORK_AGENT.model).toBe("gpt-5.6-luna");

    await admitReportAndComplete("AgentTool foreground", "low");

    await admitReportAndComplete("AgentTool background", "high");

    await admitReportAndComplete("fork", "medium");

    const resumedInput = [
      {
        type: "assistant",
        uuid: "resumed-assistant",
        message: {
          id: "resumed-assistant",
          type: "message",
          role: "assistant",
          model: "gpt-5.6-sol",
          content: [
            {
              type: "tool_use",
              id: "orphaned-tool-use",
              name: "Read",
              input: { file_path: "src/old.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "resumed-user",
        message: {
          role: "user",
          content: [{ type: "text", text: "resumed answer" }],
        },
      },
    ];
    const filteredResume = resumedInput.filter(
      (message) => message.type !== "assistant",
    );
    expect(filteredResume).toHaveLength(1);
    const resumeProjection = applyWorkerRuntimeToAppState(
      { effortValue: "max" },
      resolveWorkerRuntime("xhigh"),
    );
    expect(resumeProjection.effortValue).toBe("xhigh");
    expect(buildWorkerReportInstruction("resume", "xhigh")).toContain(
      '"effort_used":"xhigh"',
    );
    await admitReportAndComplete("resume", "xhigh");

    const inProcessReport = buildWorkerTeamReportFromMessages({
      taskId: "in-process-task",
      runId: "in-process-run",
      workerId: "in-process-worker",
      policyEpoch: 0,
      policyDigest: "0".repeat(64),
      effortUsed: "max",
      messages: [
        {
          type: "assistant",
          uuid: "in-process-record",
          requestId: "in-process-request",
          message: {
            id: "in-process-message",
            model: "gpt-5.6-luna",
            content: [
              {
                type: "text",
                text: candidateReport({
                  taskId: "in-process-task",
                  runId: "in-process-run",
                  workerId: "in-process-worker",
                  effort: "max",
                }),
              },
            ],
            usage: {
              input_tokens: 2,
              output_tokens: 3,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        },
      ],
    });
    expect(
      isWorkerReportCompletionEligible(inProcessReport, {
        policyEpoch: 0,
        policyDigest: "0".repeat(64),
      }),
    ).toBe(true);
    await admitReportAndComplete("in-process", "max");
  });

  test("tmux and iTerm2 mocked pane boundaries pin Luna, forward per-worker effort, and never launch a terminal", async () => {
    for (const type of ["tmux", "iterm2"] as const) {
      const sentCommands: string[] = [];
      const killed: string[] = [];
      const backend = fakePaneBoundary(type, sentCommands, killed);
      const runtime = resolveWorkerRuntime("xhigh");
      const command = `exec mindcode --model ${runtime.model} --effort ${runtime.effort}`;
      await backend.spawn(command);
      expect(sentCommands).toEqual([command]);
      expect(command).toContain("--model gpt-5.6-luna");
      expect(command).toContain("--effort xhigh");
      await backend.kill();
      expect(killed).toEqual([type]);
      await admitReportAndComplete(type === "iterm2" ? "iTerm2" : type, "xhigh");
    }
  });

  test("validated, stale, and missing reports all fail closed at the lifecycle boundary", async () => {
    const validReport = buildWorkerTeamReport({
      taskId: "fresh-task",
      runId: "fresh-run",
      workerId: "fresh-worker",
      policyEpoch: 0,
      policyDigest: "0".repeat(64),
      status: "completed",
      effortUsed: "medium",
      tokensUsed: 1,
      finalText: candidateReport({
        taskId: "fresh-task",
        runId: "fresh-run",
        workerId: "fresh-worker",
        effort: "medium",
      }),
    });
    expect(
      isWorkerReportCompletionEligible(validReport, {
        policyEpoch: 0,
        policyDigest: "0".repeat(64),
      }),
    ).toBe(true);

    const staleReport = buildWorkerTeamReport({
      taskId: "stale-task",
      runId: "stale-run",
      workerId: "stale-worker",
      policyEpoch: 6,
      policyDigest: "6".repeat(64),
      status: "completed",
      effortUsed: "medium",
      tokensUsed: 1,
      finalText: candidateReport({
        taskId: "stale-task",
        runId: "stale-run",
        workerId: "stale-worker",
        effort: "medium",
      }),
    });
    expect(
      isWorkerReportCompletionEligible(staleReport, {
        policyEpoch: 7,
        policyDigest: "7".repeat(64),
      }),
    ).toBe(false);
    const staleGraph = createGraph();
    const staleExecution = await acquireWorkerExecution(
      {
        taskId: "stale-task",
        owner: "stale-owner",
        schedulerScope: "stale-contract",
        effort: "medium",
        policyEpoch: 7,
        policyDigest: "7".repeat(64),
      },
      { graph: createTestWorkerTaskGraph(staleGraph) },
    );
    expect(() =>
      staleExecution.complete({
        reportId: staleReport.report_id,
        policyEpoch: staleReport.policy_epoch,
        policyDigest: staleReport.policy_digest,
      }),
    ).toThrow("stale or mismatched worker report policy epoch");
    await staleExecution.fail({
      reportId: deriveWorkerReportId("stale-task", "stale-run", "stale-worker"),
      policyEpoch: 7,
      policyDigest: "7".repeat(64),
    });

    const missingGraph = createGraph();
    const missingExecution = await acquireWorkerExecution(
      {
        taskId: "missing-report",
        owner: "missing-owner",
        schedulerScope: "missing-contract",
        effort: "low",
        policyEpoch: 0,
        policyDigest: "0".repeat(64),
      },
      { graph: createTestWorkerTaskGraph(missingGraph) },
    );
    const missingReport = buildWorkerReport({
      taskId: "missing-report",
      runId: "missing-run",
      workerId: "missing-owner",
      status: "failed",
      tokensUsed: 0,
      effortUsed: "low",
      policyEpoch: 0,
      policyDigest: "0".repeat(64),
    });
    expect(
      isWorkerReportCompletionEligible(missingReport, {
        policyEpoch: 0,
        policyDigest: "0".repeat(64),
      }),
    ).toBe(false);
    await missingExecution.fail({
      reportId: missingReport.report_id,
      policyEpoch: missingReport.policy_epoch,
      policyDigest: missingReport.policy_digest,
    });
    expect(missingGraph.requireTask("missing-report")).toMatchObject({
      status: "failed",
      lease_id: null,
    });
  });

  test("fixed Luna runtime rejects invalid effort instead of admitting a non-canonical worker", () => {
    expect(() => resolveWorkerRuntime("leader-effort")).toThrow(
      "Invalid Worker effort",
    );
    expect(resolveWorkerRuntime(undefined)).toEqual({
      model: "gpt-5.6-luna",
      effort: "medium",
    });
  });

  test("foreground and detached routes retain Leader isolation while projecting the canonical Worker runtime", () => {
    const leader = { effortValue: "max", leaderOnlyValue: "preserved" };
    const foreground = applyWorkerRuntimeToAppState(
      leader,
      resolveWorkerRuntime("low"),
    );
    const detached = applyWorkerRuntimeToAppState(
      leader,
      resolveWorkerRuntime("max"),
    );
    expect(leader).toEqual({
      effortValue: "max",
      leaderOnlyValue: "preserved",
    });
    expect(foreground).toMatchObject({
      effortValue: "low",
      leaderOnlyValue: "preserved",
    });
    expect(detached).toMatchObject({
      effortValue: "max",
      leaderOnlyValue: "preserved",
    });
    expect(
      deriveWorkerReportId("same-task", "same-run", "same-worker"),
    ).toHaveLength(64);
  });
});
