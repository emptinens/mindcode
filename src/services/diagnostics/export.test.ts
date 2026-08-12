import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeDiagnosticExport } from "./export.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("diagnostic export", () => {
  test("writes bounded JSON and HTML metadata with redaction", async () => {
    const directory = await mkdtemp(join(tmpdir(), "mindcode-diagnostics-"));
    directories.push(directory);
    const result = await writeDiagnosticExport({
      jsonPath: join(directory, "nested", "diagnostic.json"),
      htmlPath: join(directory, "nested", "diagnostic.html"),
      metadata: {
        platform: "linux",
        api_key: "forge-diagnostic-secret",
        path: "/private/project/file.ts",
        transcript: "never include this",
        counts: { recovered: 2 },
      },
    });
    const [json, html] = await Promise.all([
      readFile(result.jsonPath, "utf8"),
      readFile(result.htmlPath, "utf8"),
    ]);
    expect(json).toContain('"schema": 1');
    expect(json).toContain('"recovered": 2');
    expect(json).not.toContain("forge-diagnostic-secret");
    expect(json).not.toContain("/private/project");
    expect(json).toContain("[redacted]");
    expect(html).toContain("MindCode diagnostics");
    expect(html).not.toContain("forge-diagnostic-secret");
  });

  test("requires distinct caller-provided paths", async () => {
    await expect(
      writeDiagnosticExport({
        jsonPath: "same",
        htmlPath: "same",
        metadata: {},
      }),
    ).rejects.toThrow("must differ");
  });
});
