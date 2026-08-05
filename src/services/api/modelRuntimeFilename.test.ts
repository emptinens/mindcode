import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const sourceRoot = resolve(import.meta.dir, "../..");

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) files.push(path);
  }
  return files;
}

describe("model runtime filename", () => {
  test("does not retain stale model runtime imports or dynamic paths", () => {
    const stalePath = ["api", "claude.js"].join("/");
    const staleReferences = sourceFiles(sourceRoot).filter((path) =>
      readFileSync(path, "utf8")
        .split("//# sourceMappingURL=", 1)[0]
        .includes(stalePath),
    );

    expect(staleReferences).toEqual([]);
  });

  test("keeps the provider-neutral model runtime module", () => {
    expect(
      readFileSync(resolve(import.meta.dir, "modelRuntime.ts"), "utf8"),
    ).toContain("getVexzyClient");
  });
});
