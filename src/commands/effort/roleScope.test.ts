import { describe, expect, test } from "bun:test";

describe("/effort role boundary", () => {
  test("labels every command presentation path as Leader-only", async () => {
    const source = await Bun.file(new URL("./effort.tsx", import.meta.url)).text();

    expect(source.match(/Leader effort only:/g)).toHaveLength(4);
    expect(source).toContain("Worker effort is assigned per task by the Leader");
    expect(source).toContain("never inherits this value");
  });

  test("describes Leader and Worker scopes in the command registry", async () => {
    const source = await Bun.file(new URL("./index.ts", import.meta.url)).text();

    expect(source).toContain("Set current Leader effort");
    expect(source).toContain("Workers receive per-task effort");
    expect(source).toContain("none|minimal|low|medium|high|xhigh|max|auto");
  });
});
