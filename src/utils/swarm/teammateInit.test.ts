import { describe, expect, mock, test } from "bun:test";

const modulePath = (relativePath: string) =>
  new URL(relativePath, import.meta.url).pathname;

mock.module(modulePath("../teammate.ts"), () => ({
  getTeammateColor: () => "blue",
}));
mock.module(modulePath("../hooks/sessionHooks.ts"), () => ({
  addFunctionHook: () => undefined,
}));
mock.module(modulePath("../permissions/PermissionUpdate.ts"), () => ({
  applyPermissionUpdate: (context: unknown) => context,
}));
mock.module(modulePath("../teammateMailbox.ts"), () => ({
  createIdleNotification: () => ({}),
  writeToMailbox: async () => undefined,
}));
mock.module(modulePath("./teamHelpers.ts"), () => ({
  readTeamFile: () => undefined,
  setMemberActive: async () => undefined,
}));
mock.module(modulePath("./backends/types.ts"), () => ({
  resolveWorkerRuntime: (effort: string | undefined) => ({
    model: "gpt-5.6-luna",
    effort: effort ?? "medium",
  }),
}));
mock.module(modulePath("./workerTeamReport.ts"), () => ({
  buildWorkerTeamReportFromMessages: () => ({}),
  isWorkerReportCompletionEligibleForPolicy: () => true,
  serializeWorkerTeamReportMessage: () => "{}",
}));

const {
  initializeTeammateHooks,
  requireInheritedWorkerPolicyIdentity,
  resolveTeammateWorkerEffort,
} = await import("./teammateInit.js");

describe("teammate Worker policy admission", () => {
  test("requires an exact inherited epoch/digest pair", () => {
    expect(() => requireInheritedWorkerPolicyIdentity({})).toThrow(
      "Inherited Worker policy epoch and source digest are required",
    );
    expect(() =>
      requireInheritedWorkerPolicyIdentity({ MINDCODE_POLICY_EPOCH: "7" }),
    ).toThrow("Inherited Worker policy epoch and source digest are required");

    expect(
      requireInheritedWorkerPolicyIdentity({
        MINDCODE_POLICY_EPOCH: "7",
        MINDCODE_POLICY_DIGEST: "a".repeat(64),
      }),
    ).toEqual({
      policyEpoch: 7,
      policyDigest: "a".repeat(64),
    });
  });

  test("rejects missing policy identity at hook initialization", () => {
    expect(() =>
      initializeTeammateHooks(() => undefined, "session", {
        teamName: "team",
        agentId: "worker@team",
        agentName: "worker",
      } as never),
    ).toThrow("Teammate Worker policy epoch");
  });
});

describe("teammate Worker effort precedence", () => {
  test("CLI effort wins over a conflicting inherited Leader environment value", () => {
    const effort = resolveTeammateWorkerEffort(
      undefined,
      ["node", "mindcode", "--effort", "high"],
      { MINDCODE_WORKER_EFFORT: "low" },
    );

    expect(effort).toBe("high");
  });

  test("explicit task effort wins over both CLI and inherited values", () => {
    const effort = resolveTeammateWorkerEffort(
      "max",
      ["node", "mindcode", "--effort", "low"],
      { MINDCODE_WORKER_EFFORT: "medium" },
    );

    expect(effort).toBe("max");
  });
});
