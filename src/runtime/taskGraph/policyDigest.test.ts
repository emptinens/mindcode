import { describe, expect, test } from "bun:test";
import { TaskGraphProtocolError } from "./errors.js";
import { validateTaskRecord } from "./protocol.js";

const BASE_TASK = {
  id: "task",
  status: "pending",
  owner: null,
  kind: "implement",
  effort: "medium",
  priority: 0,
  blocked_by: [],
  claimed_at: null,
  started_at: null,
  finished_at: null,
  files_touched: [],
  read_set: [],
  write_set: [],
  isolation: "shared",
  lease_id: null,
  version: 0,
  policy_epoch: 4,
  report_id: null,
} as const;

describe("task graph policy digest wire validation", () => {
  test("normalizes omitted legacy digest to null and preserves valid digest", () => {
    expect(validateTaskRecord(BASE_TASK).policy_digest).toBeNull();
    expect(
      validateTaskRecord({
        ...BASE_TASK,
        policy_digest: "b".repeat(64),
      }).policy_digest,
    ).toBe("b".repeat(64));
  });

  test("rejects non-lowercase SHA-256 digests", () => {
    expect(() =>
      validateTaskRecord({
        ...BASE_TASK,
        policy_digest: "B".repeat(64),
      }),
    ).toThrow(TaskGraphProtocolError);
    expect(() =>
      validateTaskRecord({ ...BASE_TASK, policy_digest: "short" }),
    ).toThrow(TaskGraphProtocolError);
    expect(() =>
      validateTaskRecord({ ...BASE_TASK, policy_epoch: -1 }),
    ).toThrow(TaskGraphProtocolError);
  });
});
