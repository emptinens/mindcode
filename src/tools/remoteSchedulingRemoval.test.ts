import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const toolsSource = readFileSync(
  new URL("../tools.ts", import.meta.url),
  "utf8",
);
const bundledSkillsSource = readFileSync(
  new URL("../skills/bundled/index.ts", import.meta.url),
  "utf8",
);

test("remote trigger tool and schedule skill are not registered or imported", () => {
  for (const source of [toolsSource, bundledSkillsSource]) {
    expect(source).not.toContain("AGENT_TRIGGERS_REMOTE");
    expect(source).not.toContain("RemoteTriggerTool");
    expect(source).not.toContain("scheduleRemoteAgents");
    expect(source).not.toContain("registerScheduleRemoteAgentsSkill");
  }

  expect(existsSync(new URL("./RemoteTriggerTool/", import.meta.url))).toBe(
    false,
  );
  expect(
    existsSync(
      new URL("../skills/bundled/scheduleRemoteAgents.ts", import.meta.url),
    ),
  ).toBe(false);
});
