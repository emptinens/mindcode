import { expect, test } from "bun:test";
import { DaemonClient } from "../daemon/client.js";
import { TaskGraphDaemonClient } from "./client.js";

test("Rust task-graph RPC interoperability (opt-in)", async () => {
  if (process.env.MINDCODE_TASKGRAPH_INTEROP !== "1") return;
  const socketPath = process.env.MINDCODE_TASKGRAPH_SOCKET;
  if (!socketPath)
    throw new Error(
      "MINDCODE_TASKGRAPH_SOCKET is required when interoperability is enabled",
    );
  const client = new TaskGraphDaemonClient(new DaemonClient({ socketPath }));

  const routed = await client.route({
    id: "ts-rust-interop",
    effort: "high",
    files_touched: ["src/interop.ts"],
  });
  expect(routed.created).toBe(true);
  expect(routed.task?.effort).toBe("high");

  const read = await client.read("ts-rust-interop");
  expect(read.task?.status).toBe("pending");

  const claimed = await client.claim("ts-rust-interop", {
    owner: "gpt-5.6-luna",
    lease_id: "ts-rust-lease",
    now: "2026-08-06T00:00:00.000Z",
  });
  expect(claimed.ok).toBe(true);
  if (!claimed.ok) throw new Error(`TaskGraph claim failed: ${claimed.reason}`);

  const completed = await client.update(
    claimed.task.id,
    { status: "completed", report_id: "interop-report" },
    claimed.task.version,
  );
  expect(completed.task.status).toBe("completed");
  expect(completed.task.report_id).toBe("interop-report");

  const listed = await client.list({ status: "completed" });
  expect(listed.tasks.map((task) => task.id)).toContain("ts-rust-interop");

  const snapshot = await client.snapshot();
  expect(snapshot.tasks.some((task) => task.id === "ts-rust-interop")).toBe(
    true,
  );
});
