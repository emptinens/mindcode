import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("./resumeAgent.ts", import.meta.url),
  "utf8",
);

test("resume acquires and settles the worker lifecycle", () => {
  expect(source).toContain("import {\n  acquireWorkerExecution,");
  expect(source).toContain("getWorkerRuntimeScope(getSessionId(), getCwd())");
  expect(source).toContain(
    "filesTouched: priorTask?.files_touched.map(publicTarget)",
  );
  expect(source).toContain("readSet: priorTask?.read_set.map(publicTarget)");
  expect(source).toContain("writeSet: priorTask?.write_set.map(publicTarget)");
  expect(source).toContain(
    "onExecutionCompleted: () => settleWorkerExecution('complete')",
  );
  expect(source).toContain(
    "onExecutionFailed: () => settleWorkerExecution('fail')",
  );
  expect(source).toContain(
    "onExecutionReleased: () => settleWorkerExecution('release')",
  );
});

test("resume does not register a task before scheduler and graph admission", () => {
  const acquire = source.indexOf(
    "const workerExecution = await acquireWorkerExecution(",
  );
  const register = source.indexOf(
    "const agentBackgroundTask = registerAsyncAgent({",
  );

  expect(acquire).toBeGreaterThan(-1);
  expect(register).toBeGreaterThan(acquire);
  expect(source).toContain("settleWorkerExecution('release')");
  expect(source).toContain("killAsyncAgent(agentId, rootSetAppState)");
});

test("resume uses a new graph run after a terminal lifecycle and reuses released work", () => {
  expect(source).toContain(
    "task.status === 'pending' && task.id.startsWith(currentPrefix)",
  );
  expect(source).toContain("priorTask?.status === 'pending'");
  expect(source).toContain("return runId");
  expect(source).toContain(
    "isolation: resumedWorktreePath ? 'worktree' : 'shared'",
  );
  expect(source).not.toContain("blockedBy: priorTask?.blocked_by");
});
