import { describe, expect, test } from "bun:test";
import type { DaemonCallResult } from "../runtime/daemon/types.js";
import type { CoreToolsGitClient } from "./coreToolsGit.js";
import {
  formatGitStatus,
  getSafeGitEnvironment,
  readGitStatusWithFallback,
} from "./coreToolsGit.js";

const daemonStatus = {
  root: "/repo",
  branch: "main",
  head: "abc123",
  detached: false,
  staged: ["z.ts", "both.ts"],
  unstaged: ["a.ts", "both.ts"],
  untracked: ["new.ts", "a-new.ts"],
  conflicts: ["conflict.ts"],
};

const exactDaemonStatus = {
  ...daemonStatus,
  branch: null,
  head: null,
  changes: [
    { path: "added.ts", xy: "A." },
    { path: "copied.ts", xy: ".C" },
    { path: "deleted.ts", xy: "D." },
    { path: "renamed.ts", xy: "R." },
    { path: "conflict.ts", xy: "UU" },
  ],
};

function clientReturning(
  result: DaemonCallResult<typeof daemonStatus>,
  calls: string[],
): CoreToolsGitClient {
  return {
    async gitStatusWithFallback(params, fallback) {
      calls.push(JSON.stringify(params));
      if (result.source === "fallback") await fallback();
      return result;
    },
  };
}

describe("core tools git startup adapter", () => {
  test("formats structured daemon status deterministically", () => {
    expect(formatGitStatus(daemonStatus)).toBe(
      " M a.ts\nMM both.ts\nUU conflict.ts\nM  z.ts\n?? a-new.ts\n?? new.ts",
    );
  });

  test("uses one daemon status request and no fallback on daemon success", async () => {
    const calls: string[] = [];
    let fallbackCalls = 0;
    const result = await readGitStatusWithFallback({
      cwd: "/repo",
      client: clientReturning({ source: "daemon", value: daemonStatus }, calls),
      runStatus: async () => {
        fallbackCalls += 1;
        return "fallback";
      },
    });

    expect(result).toBe(
      " M a.ts\nMM both.ts\nUU conflict.ts\nM  z.ts\n?? a-new.ts\n?? new.ts",
    );
    expect(calls).toEqual(['{"cwd":"/repo","include_untracked":true}']);
    expect(fallbackCalls).toBe(0);
  });

  test("formats exact XY codes for structured changes", () => {
    expect(formatGitStatus(exactDaemonStatus)).toBe(
      " M a.ts\nA  added.ts\nMM both.ts\nUU conflict.ts\n C copied.ts\nD  deleted.ts\nR  renamed.ts\nM  z.ts\n?? a-new.ts\n?? new.ts",
    );
  });

  test("preserves the exact legacy fallback status output", async () => {
    const calls: string[] = [];
    const output = " M file with spaces.ts\n?? untracked.ts\n";
    const result = await readGitStatusWithFallback({
      cwd: "/repo",
      client: clientReturning(
        {
          source: "fallback",
          value: daemonStatus,
          reason: "disabled",
        },
        calls,
      ),
      runStatus: async (cwd) => {
        expect(cwd).toBe("/repo");
        return output.trim();
      },
    });

    expect(result).toBe(output.trim());
    expect(calls).toHaveLength(1);
  });

  test("inherits only the safe git environment allowlist", () => {
    const previous = {
      VEXZY_API_KEY: process.env.VEXZY_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      GITHUB_TOKEN: process.env.GITHUB_TOKEN,
      PATH: process.env.PATH,
    };
    process.env.VEXZY_API_KEY = "vexzy-secret";
    process.env.OPENAI_API_KEY = "openai-secret";
    process.env.GITHUB_TOKEN = "github-secret";
    process.env.PATH = "/bin";
    try {
      const environment = getSafeGitEnvironment();
      expect(environment.PATH).toBe("/bin");
      expect(environment.VEXZY_API_KEY).toBeUndefined();
      expect(environment.OPENAI_API_KEY).toBeUndefined();
      expect(environment.GITHUB_TOKEN).toBeUndefined();
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("does not mask semantic, cancellation, or ambiguous errors", async () => {
    const error = new Error("daemon semantic failure");
    const client: CoreToolsGitClient = {
      async gitStatusWithFallback() {
        throw error;
      },
    };

    await expect(
      readGitStatusWithFallback({
        cwd: "/repo",
        client,
        runStatus: async () => "must not run",
      }),
    ).rejects.toBe(error);
  });
});
