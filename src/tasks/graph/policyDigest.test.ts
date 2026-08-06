import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { InvalidTaskError } from "./errors.js";
import { TaskGraph } from "./taskGraph.js";

const DIGEST = "a".repeat(64);
const BAD_UPPERCASE = "A".repeat(64);
const graphs: TaskGraph[] = [];

afterEach(() => {
  for (const graph of graphs.splice(0)) graph.close();
});

function graph(): TaskGraph {
  const instance = new TaskGraph({
    databasePath: join(mkdtempSync(join("/tmp", "mindcode-policy-digest-")), "tasks.db"),
  });
  graphs.push(instance);
  return instance;
}

describe("authoritative task graph policy digest", () => {
  test("materializes legacy null and round-trips create, route, update, and snapshot", () => {
    const taskGraph = graph();
    const legacy = taskGraph.create({ id: "legacy" });
    expect(legacy.policy_epoch).toBe(0);
    expect(legacy.policy_digest).toBeNull();

    const routed = taskGraph.route({
      id: "routed",
      policy_epoch: 7,
      policy_digest: DIGEST,
    });
    expect(routed.task?.policy_digest).toBe(DIGEST);

    const updated = taskGraph.update(
      "legacy",
      { policy_epoch: 8, policy_digest: DIGEST },
      legacy.version,
    );
    expect(updated.policy_epoch).toBe(8);
    expect(updated.policy_digest).toBe(DIGEST);

    const snapshot = taskGraph.snapshot();
    expect(snapshot.tasks.map((task) => [task.id, task.policy_digest])).toEqual([
      ["legacy", DIGEST],
      ["routed", DIGEST],
    ]);
  });

  test("accepts explicit null and rejects malformed or unpaired identities", () => {
    const taskGraph = graph();
    expect(() =>
      taskGraph.create({ id: "unpaired", policy_digest: DIGEST }),
    ).toThrow("policy_epoch and policy_digest must be provided together");
    expect(() =>
      taskGraph.create({ id: "unpaired-epoch", policy_epoch: 1 }),
    ).toThrow("policy_epoch and policy_digest must be provided together");
    expect(() =>
      taskGraph.create({ id: "uppercase", policy_epoch: 1, policy_digest: BAD_UPPERCASE }),
    ).toThrow(InvalidTaskError);
    const task = taskGraph.create({
      id: "clearable",
      policy_epoch: 1,
      policy_digest: DIGEST,
    });
    expect(() =>
      taskGraph.update(task.id, { policy_epoch: 2 }),
    ).toThrow("provided together in a patch");
    expect(() =>
      taskGraph.routeUpdate(task.id, { policy_digest: DIGEST }),
    ).toThrow("provided together in a patch");
    expect(() =>
      taskGraph.update(task.id, { policy_digest: "not-a-digest" }),
    ).toThrow("provided together in a patch");
    const cleared = taskGraph.update(
      task.id,
      { policy_epoch: 1, policy_digest: null },
      task.version,
    );
    expect(cleared.policy_digest).toBeNull();
  });
});
