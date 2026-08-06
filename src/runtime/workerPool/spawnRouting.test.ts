import { describe, expect, test } from "bun:test";
import {
  DEFAULT_IN_PROCESS_WORKER_POOL_SLOTS,
  MAX_IN_PROCESS_WORKER_POOL_SLOTS,
  decideInProcessWorkerSpawn,
  getInProcessWorkerPoolSize,
  toInProcessWorkerPoolRequest,
} from "./spawnRouting.js";

const request = (overrides: Record<string, unknown> = {}) => ({
  projectId: "/project",
  sessionId: "session",
  model: "gpt-5.6-luna",
  effort: "medium",
  ...overrides,
});

describe("in-process worker spawn routing", () => {
  test("routes low and medium Luna work to the warm path", () => {
    expect(
      decideInProcessWorkerSpawn(request({ effort: "low" })),
    ).toMatchObject({
      kind: "warm",
      mode: "warm",
      model: "gpt-5.6-luna",
      effort: "low",
    });
    expect(decideInProcessWorkerSpawn(request())).toMatchObject({
      kind: "warm",
      mode: "warm",
      model: "gpt-5.6-luna",
      effort: "medium",
    });
  });

  test("routes expensive, overlapping, and isolated work cold", () => {
    for (const effort of ["high", "xhigh", "max"]) {
      expect(decideInProcessWorkerSpawn(request({ effort }))).toMatchObject({
        kind: "fallback",
        mode: "cold",
        isolation: "isolated",
        model: "gpt-5.6-luna",
        scheduler: "unchanged",
      });
    }
    expect(
      decideInProcessWorkerSpawn(request({ writeOverlap: true })),
    ).toMatchObject({ kind: "fallback", reason: "write-overlap" });
    expect(
      decideInProcessWorkerSpawn(request({ isolation: "worktree" })),
    ).toMatchObject({ kind: "fallback", reason: "isolation" });
  });

  test("keeps the worker model fixed even when a caller supplies another model", () => {
    expect(
      decideInProcessWorkerSpawn(request({ model: "gpt-5.6-sol" })),
    ).toMatchObject({
      kind: "fallback",
      model: "gpt-5.6-luna",
      reason: "model",
      scheduler: "unchanged",
    });
  });

  test("bounds configured pool capacity at 64", () => {
    expect(
      getInProcessWorkerPoolSize({
        MINDCODE_IN_PROCESS_WORKER_POOL_MAX: "999",
      }),
    ).toBe(MAX_IN_PROCESS_WORKER_POOL_SLOTS);
    expect(
      getInProcessWorkerPoolSize({ MINDCODE_IN_PROCESS_WORKER_POOL_MAX: "0" }),
    ).toBe(DEFAULT_IN_PROCESS_WORKER_POOL_SLOTS);
  });

  test("maps worktree isolation to the cold pool route", () => {
    expect(
      toInProcessWorkerPoolRequest(request({ isolation: "worktree" })),
    ).toMatchObject({ isolation: "isolated" });
  });
});
