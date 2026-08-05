import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateVexzyCredits } from "../../services/credits/accounting.js";
import {
  type StatusReportData,
  generateStatusHtmlReport,
  renderStatusHtml,
} from "./report.js";

const originalConfigDir = process.env.MINDCODE_CONFIG_DIR;

afterEach(() => {
  if (originalConfigDir === undefined) {
    Reflect.deleteProperty(process.env, "MINDCODE_CONFIG_DIR");
  } else {
    process.env.MINDCODE_CONFIG_DIR = originalConfigDir;
  }
});

function fixture(): StatusReportData {
  const generatedAt = new Date("2026-08-05T12:00:00.000Z");
  return {
    generatedAt,
    sessionId: "session-<unsafe>&\"'",
    sessionStartedAt: new Date("2026-08-05T11:00:00.000Z"),
    requestCount: 7,
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 300,
    cacheWriteTokens: 100,
    reasoningTokens: 400,
    wallDurationMs: 120_000,
    apiDurationMs: 90_000,
    apiDurationWithoutRetriesMs: 75_000,
    toolCount: 12,
    toolDurationMs: 30_000,
    webSearchRequests: 2,
    linesAdded: 20,
    linesRemoved: 5,
    models: [
      {
        name: '<model onmouseover="bad">',
        requests: 7,
        inputTokens: 1_000,
        outputTokens: 2_000,
        cacheReadTokens: 300,
        cacheWriteTokens: 100,
        reasoningTokens: 400,
        webSearchRequests: 2,
        priceCreditsPerMillion: 100,
        credits: calculateVexzyCredits(
          {
            inputTokens: 1_000,
            outputTokens: 2_000,
            cacheReadTokens: 300,
            cacheWriteTokens: 100,
            reasoningTokens: 400,
          },
          100,
        ),
      },
    ],
    scheduler: {
      activeWorkers: 3,
      queuedWorkers: 2,
      activeWeight: 12,
      queuedWeight: 6,
      budget: 32,
      availableWeight: 20,
    },
    context: {
      effectiveWindow: 1_030_000,
      warningPercent: 85,
      compactPercent: 95,
      warningTokens: 875_500,
      compactTokens: 978_500,
    },
    taskGraph: "initialized",
    workerModel: "gpt-5.6-luna",
    credits: {
      ...calculateVexzyCredits(
        {
          inputTokens: 1_000,
          outputTokens: 2_000,
          cacheReadTokens: 300,
          cacheWriteTokens: 100,
          reasoningTokens: 400,
        },
        100,
      ),
      requests: 7,
      modelsWithoutPrice: 0,
    },
  };
}

describe("status HTML report", () => {
  test("plain /status generates HTML while /status ui preserves the panel", async () => {
    const source = await Bun.file(
      new URL("./status.tsx", import.meta.url),
    ).text();

    expect(source).toContain("mode === '' || mode === 'html'");
    expect(source).toContain("mode === 'ui' || mode === 'panel'");
    expect(source).toContain("generateStatusHtmlReport()");
  });

  test("escapes dynamic values and renders scheduler metrics", () => {
    const html = renderStatusHtml(fixture());

    expect(html).toContain("session-&lt;unsafe&gt;&amp;&quot;&#039;");
    expect(html).toContain("&lt;model onmouseover=&quot;bad&quot;&gt;");
    expect(html).not.toContain('<model onmouseover="bad">');
    expect(html).toContain("3 active · 2 queued");
    expect(html).toContain("12 active / 32 total weight");
    expect(html).toContain("gpt-5.6-luna · configured VEXZY model");
    expect(html).toContain("Retry overhead");
    expect(html).toContain("875,500 tokens");
    expect(html).toContain("Session credits");
    expect(html).toContain("Input credits");
  });

  test("contains compact self-contained Sakura report without legacy branding", () => {
    const html = renderStatusHtml(fixture());
    const normalized = html.toLowerCase();

    expect(html).toContain("<svg");
    expect(html).toContain("color-scheme:light");
    expect(html).toContain("@keyframes fall");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain("style=");
    expect(normalized).not.toContain("claude");
    expect(normalized).not.toContain("anthropic");
    expect(normalized).not.toContain("usd");
    expect(normalized).not.toContain("session cost");
  });

  test("writes a generated report file", async () => {
    const configDir = await mkdtemp(join(tmpdir(), "mindcode-status-"));
    process.env.MINDCODE_CONFIG_DIR = configDir;

    try {
      const path = await generateStatusHtmlReport();
      const html = await readFile(path, "utf8");
      expect(path).toContain(join(configDir, "reports"));
      expect(html).toContain("MindCode");
      expect(html).toContain("Runtime architecture");
    } finally {
      await rm(configDir, { recursive: true, force: true });
    }
  });
});
