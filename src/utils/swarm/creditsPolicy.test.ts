import { describe, expect, test } from "bun:test";
import {
  CREDITS_WEIGHTS,
  CreditsFirstPolicy,
  HARD_WORKER_CAP,
} from "./creditsPolicy.js";

describe("credits-first swarm policy", () => {
  test("uses bounded effort weights", () => {
    expect(CREDITS_WEIGHTS).toMatchObject({
      low: 1,
      medium: 2,
      high: 4,
      max: 8,
    });
    const policy = new CreditsFirstPolicy({
      forecastBudget: 16,
      criticalReserve: 4,
    });
    expect(
      policy.tryAcquire({ id: "a", effort: "high", priority: "high" })?.weight,
    ).toBe(4);
  });

  test("holds the critical reserve from low and medium work", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 10,
      criticalReserve: 4,
    });
    const low = policy.tryAcquire({
      id: "low",
      priority: "low",
      estimatedCost: 7,
    });
    expect(low).toBeUndefined();
    const critical = policy.tryAcquire({
      id: "critical",
      priority: "critical",
      estimatedCost: 6,
    });
    expect(critical).toBeDefined();
  });

  test("critical high/max work outranks aged low/medium work", async () => {
    let now = 0;
    const policy = new CreditsFirstPolicy({
      forecastBudget: 8,
      criticalReserve: 0,
      now: () => now,
      agingWindowMs: 10,
    });
    const active = policy.tryAcquire({
      id: "active",
      priority: "medium",
      estimatedCost: 8,
    });
    const low = policy.acquire({
      id: "low",
      priority: "low",
      estimatedCost: 1,
    });
    now = 100;
    const critical = policy.acquire({
      id: "critical",
      priority: "critical",
      effort: "max",
      estimatedCost: 8,
    });
    active?.release();
    await expect(critical).resolves.toMatchObject({ id: "critical" });
    expect(policy.snapshot().queued).toBe(1);
    low.catch(() => undefined);
  });

  test("stops after twice the forecast budget", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 5,
      criticalReserve: 0,
    });
    const lease = policy.tryAcquire({
      id: "a",
      priority: "critical",
      estimatedCost: 1,
    });
    lease?.release(10);
    expect(policy.snapshot()).toMatchObject({ consumed: 10, stopped: true });
    expect(
      policy.tryAcquire({ id: "b", priority: "critical", estimatedCost: 1 }),
    ).toBeUndefined();
  });

  test("rejects a next lease when consumed plus reservations would overshoot hard stop", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 5,
      criticalReserve: 0,
    });
    const first = policy.tryAcquire({
      id: "first",
      priority: "critical",
      estimatedCost: 4,
    });
    expect(first).toBeDefined();
    first?.release(5);

    expect(
      policy.canAdmit({
        id: "next",
        priority: "critical",
        estimatedCost: 6,
      }),
    ).toMatchObject({ admitted: false, reason: "hard-stop" });
    expect(policy.snapshot()).toMatchObject({
      consumed: 5,
      committed: 5,
      hardStopRemaining: 5,
    });
  });

  test("rejects permanently inadmissible budget and reserve requests", async () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 8,
      hardStopAt: 16,
      criticalReserve: 3,
    });

    await expect(
      policy.acquire({
        id: "oversized-high",
        priority: "high",
        estimatedCost: 9,
      }),
    ).rejects.toThrow("budget");
    await expect(
      policy.acquire({
        id: "reserve-blocked",
        priority: "medium",
        estimatedCost: 6,
      }),
    ).rejects.toThrow("critical-reserve");
    expect(policy.snapshot()).toMatchObject({ queued: 0, estimatedQueued: 0 });
  });

  test("rejects a queued request when measured usage makes the hard stop permanent", async () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 4,
      hardStopAt: 8,
      criticalReserve: 0,
      workerCap: 1,
    });
    const active = policy.tryAcquire({
      id: "active",
      priority: "high",
      estimatedCost: 4,
    });
    const waiting = policy.acquire({
      id: "waiting",
      priority: "high",
      estimatedCost: 4,
    });

    active?.release(8);
    await expect(waiting).rejects.toThrow("hard-stop");
    expect(policy.snapshot()).toMatchObject({
      consumed: 8,
      active: 0,
      queued: 0,
      estimatedQueued: 0,
    });
  });

  test("records external provider usage in policy telemetry", () => {
    const policy = new CreditsFirstPolicy({ forecastBudget: 10 });
    expect(policy.recordConsumedCredits(3)).toBe(3);
    expect(policy.snapshot()).toMatchObject({
      consumed: 3,
      committed: 3,
      hardStopRemaining: 17,
    });
  });

  test("enforces the secondary worker cap", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 1000,
      criticalReserve: 0,
      workerCap: 2,
    });
    expect(
      policy.tryAcquire({ id: "a", priority: "critical", estimatedCost: 1 }),
    ).toBeDefined();
    expect(
      policy.tryAcquire({ id: "b", priority: "critical", estimatedCost: 1 }),
    ).toBeDefined();
    expect(
      policy.canAdmit({ id: "c", priority: "critical", estimatedCost: 1 })
        .reason,
    ).toBe("worker-cap");
    expect(HARD_WORKER_CAP).toBe(64);
  });

  test("counts only active workers against the cap and queues waiters", async () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 100,
      criticalReserve: 0,
      workerCap: 1,
    });
    const active = policy.tryAcquire({ id: "active", estimatedCost: 1 });
    const waiting = policy.acquire({ id: "waiting", estimatedCost: 1 });

    expect(policy.snapshot()).toMatchObject({ active: 1, queued: 1 });
    active?.release(1);
    await expect(waiting).resolves.toMatchObject({ id: "waiting" });
    expect(policy.snapshot()).toMatchObject({ active: 1, queued: 0 });
  });

  test("clamps configured worker cap to the documented maximum", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 1000,
      workerCap: 1000,
    });
    expect(policy.snapshot().workerCap).toBe(HARD_WORKER_CAP);
  });

  test("reports deterministic counters and estimated cost", () => {
    const policy = new CreditsFirstPolicy({
      forecastBudget: 20,
      criticalReserve: 3,
      now: () => 7,
    });
    const lease = policy.tryAcquire({
      id: "a",
      priority: "high",
      estimatedCost: 4,
    });
    expect(policy.snapshot()).toMatchObject({
      active: 1,
      queued: 0,
      estimatedActive: 4,
      consumed: 0,
      available: 16,
    });
    lease?.release(2);
    expect(policy.snapshot()).toMatchObject({
      active: 0,
      consumed: 2,
      estimatedActive: 0,
      queuedEstimated: 0,
    });
  });
});
