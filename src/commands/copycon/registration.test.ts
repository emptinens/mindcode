import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("/copycon is registered as a builtin command", () => {
  const registry = readFileSync(
    new URL("../../commands.ts", import.meta.url),
    "utf8",
  );
  expect(registry).toContain(
    "import copycon from './commands/copycon/index.js'",
  );
  expect(registry).toMatch(/\n\s*copycon,\n/);
});
