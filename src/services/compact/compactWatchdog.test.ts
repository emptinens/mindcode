import { afterEach, describe, expect, test } from "bun:test";
import { createFileStateCacheWithSizeLimit } from "../../utils/fileStateCache.js";
import {
  clearCompactWarningSuppression,
  compactWarningStore,
  suppressCompactWarning,
} from "./compactWarningState.js";
import {
  CompactTimeoutError,
  DEFAULT_COMPACT_TIMEOUT_MS,
  createCompactWatchdog,
  resolveCompactTimeoutMs,
  commitCompactState,
  restoreCompactState,
  snapshotCompactState,
} from "./compactWatchdog.js";

const originalTimeout = process.env.MINDCODE_COMPACT_TIMEOUT_MS;

afterEach(() => {
  if (originalTimeout === undefined) {
    Reflect.deleteProperty(process.env, "MINDCODE_COMPACT_TIMEOUT_MS");
  } else {
    process.env.MINDCODE_COMPACT_TIMEOUT_MS = originalTimeout;
  }
});

describe("compact watchdog", () => {
  test("uses a bounded default and accepts a positive override", () => {
    expect(resolveCompactTimeoutMs(undefined)).toBe(DEFAULT_COMPACT_TIMEOUT_MS);
    expect(resolveCompactTimeoutMs("25")).toBe(25);
    expect(resolveCompactTimeoutMs("0")).toBe(DEFAULT_COMPACT_TIMEOUT_MS);
    expect(resolveCompactTimeoutMs("invalid")).toBe(DEFAULT_COMPACT_TIMEOUT_MS);
  });

  test("rejects a stalled operation and aborts only the child scope", async () => {
    const parent = new AbortController();
    const watchdog = createCompactWatchdog(parent, 10);

    await expect(
      watchdog.guard(new Promise(() => undefined)),
    ).rejects.toBeInstanceOf(CompactTimeoutError);
    expect(watchdog.controller.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
    watchdog.dispose();
  });

  test("propagates parent cancellation and clears the timer", async () => {
    const parent = new AbortController();
    const watchdog = createCompactWatchdog(parent, 1000);
    const pending = watchdog.guard(new Promise(() => undefined));

    parent.abort(new Error("parent canceled"));
    await expect(pending).rejects.toThrow("parent canceled");
    watchdog.dispose();
  });
});

describe("compact state transaction", () => {
  test("commits state only after successful compaction", () => {
    const cache = createFileStateCacheWithSizeLimit(10);
    cache.set("/tmp/a.txt", {
      content: "a",
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    });
    const loaded = new Set(["/tmp/MINDCODE.md"]);
    const snapshot = snapshotCompactState(cache, loaded);

    commitCompactState(cache, loaded);

    expect(cache.size).toBe(0);
    expect(loaded.size).toBe(0);
    restoreCompactState(cache, loaded, snapshot);
    expect(cache.get("/tmp/a.txt")?.content).toBe("a");
    expect([...loaded]).toEqual(["/tmp/MINDCODE.md"]);
  });

  test("rolls back cache and nested-memory paths after failure", () => {
    const cache = createFileStateCacheWithSizeLimit(10);
    cache.set("/tmp/a.txt", {
      content: "original",
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    });
    const loaded = new Set(["/tmp/MINDCODE.md"]);
    const snapshot = snapshotCompactState(cache, loaded);

    cache.clear();
    loaded.clear();
    restoreCompactState(cache, loaded, snapshot);

    expect(cache.get("/tmp/a.txt")?.content).toBe("original");
    expect([...loaded]).toEqual(["/tmp/MINDCODE.md"]);
  });
});



describe("compact warning state", () => {
  test("suppresses and clears the warning state", () => {
    clearCompactWarningSuppression();
    expect(compactWarningStore.getState()).toBe(false);

    suppressCompactWarning();
    expect(compactWarningStore.getState()).toBe(true);

    clearCompactWarningSuppression();
    expect(compactWarningStore.getState()).toBe(false);
  });
});
