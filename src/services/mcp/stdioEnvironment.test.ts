import { describe, expect, test } from "bun:test";
import { getMcpSdkEnvironment } from "./stdioEnvironment.js";

describe("MCP stdio SDK environment", () => {
  test("inherits only bounded runtime keys and drops ambient credentials", () => {
    expect(
      getMcpSdkEnvironment(undefined, {
        PATH: "/bin",
        HOME: "/home/test",
        LC_ALL: "C",
        GITHUB_TOKEN: "ambient-github",
        OPENAI_API_KEY: "ambient-openai",
        AWS_SECRET_ACCESS_KEY: "ambient-aws",
        VEXZY_API_KEY: "forge-secret",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/test", LC_ALL: "C" });
  });

  test("keeps explicit MCP credentials but never forwards MindCode auth", () => {
    expect(
      getMcpSdkEnvironment(
        {
          OPENAI_API_KEY: "explicit-server-key",
          CUSTOM_TOKEN: "explicit-token",
          VEXZY_API_KEY: "forge-secret",
          Authorization: "Bearer secret",
        },
        { PATH: "/bin" },
      ),
    ).toEqual({
      PATH: "/bin",
      OPENAI_API_KEY: "explicit-server-key",
      CUSTOM_TOKEN: "explicit-token",
    });
  });
});
