import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringWidth } from "../../ink/stringWidth.js";
import { SAKURA_ART, SAKURA_HEIGHT, SAKURA_WIDTH } from "./sakuraArt.js";

test("Sakura mascot keeps a stable terminal footprint", () => {
  expect(SAKURA_WIDTH).toBe(17);
  expect(SAKURA_HEIGHT).toBe(6);
  for (const frame of Object.values(SAKURA_ART)) {
    expect(frame).toHaveLength(SAKURA_HEIGHT);
    expect(frame.every((row) => stringWidth(row) === SAKURA_WIDTH)).toBe(true);
  }
});

test("Sakura art has a snapshot-stable default frame", () => {
  expect(SAKURA_ART.default).toMatchInlineSnapshot(`
    [
      "      ·   ❀      ",
      "    · ❀ ✿ ❀ ·    ",
      "   ❀ ✿╲✿╱✿ ❀  ·  ",
      "   ╲ ╲│╱ ╱   ❀   ",
      "        │        ",
      "       ╱┴╲       ",
    ]
  `);
});

test("animation is disabled outside interactive full-screen motion contexts", () => {
  const source = readFileSync(
    resolve(import.meta.dir, "AnimatedSakura.tsx"),
    "utf8",
  );
  expect(source).toContain("compact");
  expect(source).toContain("interactive");
  expect(source).toContain("prefersReducedMotion");
  expect(source).toContain("clearTimeout");
});

test("LogoV2 contains no legacy mascot symbols or names", () => {
  const root = resolve(import.meta.dir);
  const files = [
    "Sakura.tsx",
    "AnimatedSakura.tsx",
    "LogoV2.tsx",
    "CondensedLogo.tsx",
    "WelcomeV2.tsx",
  ];
  const source = files
    .map((file) => readFileSync(resolve(root, file), "utf8"))
    .join("\n");
  expect(source).not.toContain("Clawd");
  expect(source).not.toContain("clawd_");
  expect(source).not.toContain("Anthropic");
  expect(source).toContain("Sakura");
  expect(source).toContain("MindCode");
});
