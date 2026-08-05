import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ForegroundAgentHandoff } from "./foregroundHandoff.js";

const source = readFileSync(
  new URL("./AgentTool.tsx", import.meta.url),
  "utf8",
);
const runAgentSource = readFileSync(
  new URL("./runAgent.ts", import.meta.url),
  "utf8",
);

test("backgrounding continues the pending iterator instead of restarting the worker", () => {
  const start = source.indexOf("if (raceResult.type === 'background'");
  const end = source.indexOf(
    "// Return async_launched result immediately",
    start,
  );
  const transition = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(transition).toContain(
    "let backgroundResult = await raceResult.pendingMessage",
  );
  expect(transition).toContain("backgroundResult = await agentIterator.next()");
  expect(transition).not.toContain("agentIterator.return(");
  expect(transition).not.toContain("runAgent({");
  expect(source).toContain(
    "raceResult.type === 'background' ? await raceResult.pendingMessage : raceResult.result",
  );
  expect(source).toContain("isBackgroundTasksDisabled ? {} : {");
  expect(source).toContain("isBackgrounded: () => wasBackgrounded");
  expect(source).toContain("backgroundAgentTask(foregroundTaskId");
  expect(source).toContain("if (foregroundTaskId && !wasBackgrounded)");
  expect(runAgentSource).toContain("isAsync || currentlyBackgrounded");
  expect(runAgentSource).toContain("isAsync || canTransitionToBackground");
  expect(runAgentSource).toContain("isAsync || isBackgrounded?.() === true");
  expect(runAgentSource).toContain(
    "shareSetAppState: !isAsync && !canTransitionToBackground",
  );
});

test("simultaneous completion and background request hands off exactly once", async () => {
  let resolveBackground!: () => void;
  const backgroundSignal = new Promise<void>((resolve) => {
    resolveBackground = resolve;
  });
  const handoff = new ForegroundAgentHandoff(backgroundSignal);
  const completed = Promise.resolve<IteratorResult<string, void>>({
    done: true,
    value: undefined,
  });

  resolveBackground();
  const first = await handoff.next(completed, () => true);
  expect(first.type).toBe("background");
  if (first.type === "background") {
    expect((await first.pendingMessage).done).toBe(true);
  }

  const second = await handoff.next(
    Promise.resolve({ done: false, value: "already handed off" }),
    () => true,
  );
  expect(second).toEqual({
    type: "message",
    result: { done: false, value: "already handed off" },
  });
});

test("background state wins when the final message settles before its signal", async () => {
  const handoff = new ForegroundAgentHandoff(new Promise<void>(() => {}));
  const result = await handoff.next(
    Promise.resolve<IteratorResult<string, void>>({
      done: true,
      value: undefined,
    }),
    () => true,
  );

  expect(result.type).toBe("background");
  if (result.type === "background") {
    expect((await result.pendingMessage).done).toBe(true);
  }
});

test("background state owns a simultaneous iterator rejection", async () => {
  const expected = new Error("stream failed during handoff");
  const pendingMessage = Promise.reject<IteratorResult<string, void>>(expected);
  const handoff = new ForegroundAgentHandoff(new Promise<void>(() => {}));

  const result = await handoff.next(pendingMessage, () => true);
  expect(result.type).toBe("background");
  if (result.type === "background") {
    await expect(result.pendingMessage).rejects.toBe(expected);
  }
});

test("foreground iterator rejection still propagates without a handoff", async () => {
  const expected = new Error("foreground stream failed");
  const handoff = new ForegroundAgentHandoff(new Promise<void>(() => {}));

  await expect(
    handoff.next(
      Promise.reject<IteratorResult<string, void>>(expected),
      () => false,
    ),
  ).rejects.toBe(expected);
});

test("preflight waits are bounded and runtime scoped", () => {
  expect(source).toContain("createAgentWorktreeWithTimeout");
  expect(source).toContain("getWorkerRuntimeScope(getSessionId(), getCwd())");
  expect(source).toContain("resolveExternalDependency: async dependencyId");
  expect(source).toContain(
    "const shouldRunAsync = run_in_background !== false",
  );
});
