import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import figures from "figures";

function loadTaskIconResolver(): (status: never) => {
  icon: string;
  color: unknown;
} {
  const sourcePath = fileURLToPath(
    new URL("./TaskListV2.tsx", import.meta.url),
  );
  const source = readFileSync(sourcePath, "utf8");
  const start = source.indexOf("function getTaskIcon");
  const end = source.indexOf("function TaskItem", start);

  if (start < 0 || end < 0) {
    throw new Error("TaskListV2 status resolver was not found");
  }

  const resolverSource = source.slice(start, end);
  const javascript = new Bun.Transpiler({ loader: "tsx" }).transformSync(
    resolverSource,
  );
  return new Function("figures", `${javascript}; return getTaskIcon`)(
    figures,
  ) as ReturnType<typeof loadTaskIconResolver>;
}

describe("TaskListV2 task status renderer", () => {
  test.each(["legacy", "cancelled", "blocked", "unknown"])(
    "falls back for unknown status %s",
    (status) => {
      const getTaskIcon = loadTaskIconResolver();

      expect(getTaskIcon(status as never)).toEqual({
        icon: figures.squareSmall,
        color: undefined,
      });
    },
  );
});
