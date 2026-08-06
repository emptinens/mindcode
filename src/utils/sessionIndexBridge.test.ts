import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DaemonCallResult } from "../runtime/daemon/index.js";
import type {
  SessionIndexListParams,
  SessionIndexRecord,
  SessionIndexResponse,
} from "../runtime/sessionIndex/index.js";
import {
  type SessionFileSnapshot,
  SessionIndexBridge,
  type SessionIndexClientLike,
} from "./sessionIndexBridge.js";

type FakeMode = "daemon" | "fallback";

function fakeClient(
  sessions: SessionIndexRecord[],
  mode: FakeMode = "daemon",
): SessionIndexClientLike & {
  listParams: SessionIndexListParams[];
  upserts: SessionIndexRecord[];
  removals: string[];
} {
  const listParams: SessionIndexListParams[] = [];
  const upserts: SessionIndexRecord[] = [];
  const removals: string[] = [];
  return {
    listParams,
    upserts,
    removals,
    async listWithFallback(params, fallback) {
      listParams.push(params);
      if (mode === "daemon") {
        return {
          source: "daemon",
          value: { sessions },
        } satisfies DaemonCallResult<SessionIndexResponse["list"]>;
      }
      return {
        source: "fallback",
        value: await fallback(),
        reason: "disabled",
      } satisfies DaemonCallResult<SessionIndexResponse["list"]>;
    },
    async upsert(session) {
      upserts.push(session);
      return { session };
    },
    async remove(sessionId) {
      removals.push(sessionId);
      return { removed: true };
    },
  };
}

function snapshot(
  projectDir: string,
  sessionId: string,
  mtime: number,
): SessionFileSnapshot {
  return {
    sessionId,
    path: join(projectDir, `${sessionId}.jsonl`),
    mtime,
    ctime: mtime - 1,
    size: mtime,
  };
}

describe("SessionIndexBridge", () => {
  test("uses a non-empty daemon index without scanning the filesystem", async () => {
    const projectDir = "/state/project";
    const record: SessionIndexRecord = {
      session_id: "session-a",
      project_path: projectDir,
      transcript_path: join(projectDir, "session-a.jsonl"),
      modified_at_ms: 20,
      size_bytes: 10,
      title: "Indexed title",
      first_prompt: "Indexed prompt",
    };
    const client = fakeClient([record]);
    let scans = 0;
    const bridge = new SessionIndexBridge({ client });

    const result = await bridge.listOrScan(projectDir, 25, async () => {
      scans++;
      return [];
    });

    expect(result).toEqual({
      source: "daemon",
      files: [
        {
          sessionId: "session-a",
          path: record.transcript_path,
          mtime: 20,
          ctime: 20,
          size: 10,
          title: "Indexed title",
          firstPrompt: "Indexed prompt",
        },
      ],
    });
    expect(scans).toBe(0);
    expect(client.listParams).toEqual([
      { project_path: projectDir, limit: 25 },
    ]);
  });

  test("scans and seeds the daemon only when its project index is empty", async () => {
    const projectDir = "/state/project";
    const client = fakeClient([]);
    const bridge = new SessionIndexBridge({ client });
    const files = [
      snapshot(projectDir, "older", 10),
      snapshot(projectDir, "newer", 20),
    ];

    const result = await bridge.listOrScan(projectDir, 1, async () => files);

    expect(result.source).toBe("filesystem");
    expect(result.files.map((file) => file.sessionId)).toEqual(["newer"]);
    expect(client.upserts.map((record) => record.session_id)).toEqual([
      "newer",
      "older",
    ]);
  });

  test("uses one filesystem fallback and does not attempt mutations when daemon is unavailable", async () => {
    const projectDir = "/state/project";
    const client = fakeClient([], "fallback");
    const bridge = new SessionIndexBridge({ client });
    let scans = 0;

    const result = await bridge.listOrScan(projectDir, undefined, async () => {
      scans++;
      return [snapshot(projectDir, "session-a", 10)];
    });

    expect(result.source).toBe("filesystem");
    expect(result.files).toHaveLength(1);
    expect(scans).toBe(1);
    expect(client.upserts).toHaveLength(0);
  });

  test("rejects poisoned transcript paths and rebuilds from the filesystem", async () => {
    const projectDir = "/state/project";
    const client = fakeClient([
      {
        session_id: "session-a",
        project_path: projectDir,
        transcript_path: "/private/session-a.jsonl",
        modified_at_ms: 10,
        size_bytes: 1,
      },
    ]);
    const bridge = new SessionIndexBridge({ client });
    const result = await bridge.listOrScan(projectDir, undefined, async () => [
      snapshot(projectDir, "session-b", 20),
    ]);

    expect(result.files.map((file) => file.sessionId)).toEqual(["session-b"]);
    expect(client.upserts.at(-1)?.session_id).toBe("session-b");
  });

  test("coalesces identical writes and redacts bounded metadata", async () => {
    const projectDir = "/state/project";
    const client = fakeClient([]);
    const bridge = new SessionIndexBridge({ client });
    const file: SessionFileSnapshot = {
      ...snapshot(projectDir, "session-a", 10),
      title: "forge-super-secret",
      firstPrompt: "Authorization: Bearer abc.def.secret",
    };

    const results = await Promise.all([
      bridge.upsert(projectDir, file),
      bridge.upsert(projectDir, file),
    ]);

    expect(results).toEqual([true, true]);
    expect(client.upserts).toHaveLength(1);
    expect(client.upserts[0]?.title).toBe("[REDACTED]");
    expect(client.upserts[0]?.first_prompt).not.toContain("abc.def.secret");
  });

  test("refreshes stat metadata without reading transcript contents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-session-index-"));
    try {
      const sessionId = "session-a";
      const transcriptPath = join(directory, `${sessionId}.jsonl`);
      await writeFile(
        transcriptPath,
        '{"type":"user","secret":"never-read"}\n',
      );
      const client = fakeClient([]);
      const bridge = new SessionIndexBridge({ client });

      expect(
        await bridge.refresh({
          sessionId,
          projectDir: directory,
          transcriptPath,
        }),
      ).toBe(true);

      expect(client.upserts).toHaveLength(1);
      expect(client.upserts[0]).toEqual({
        session_id: sessionId,
        project_path: directory,
        transcript_path: transcriptPath,
        modified_at_ms: expect.any(Number),
        size_bytes: 38,
      });
      expect(JSON.stringify(client.upserts[0])).not.toContain("never-read");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
