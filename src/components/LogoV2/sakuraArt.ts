import { stringWidth } from "../../ink/stringWidth.js";

export type SakuraPose = "default" | "bloom" | "fall-left" | "fall-right";

export const SAKURA_WIDTH = 17;
export const SAKURA_HEIGHT = 7;

export type SakuraFrame = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

const center = (row: string): string => {
  const width = stringWidth(row);
  if (width >= SAKURA_WIDTH) return row.slice(0, SAKURA_WIDTH);
  const left = Math.floor((SAKURA_WIDTH - width) / 2);
  return " ".repeat(left) + row + " ".repeat(SAKURA_WIDTH - width - left);
};

/**
 * Compact sakura tree art. Rows are normalized with the same width function
 * used by the terminal renderer; no emoji presentation characters are used.
 */
const frame = (...rows: string[]): SakuraFrame =>
  rows.map(center) as SakuraFrame;

export const SAKURA_ART: Readonly<Record<SakuraPose, SakuraFrame>> = {
  default: frame(
    "    .-^-.",
    "  .-' ✿ '-.",
    " .' ✿ ❀ ✿ '.",
    "/ ✿  ╲│╱  ✿ \\",
    "      ╱│╲",
    "       │",
    "      ╱┴╲",
  ),
  bloom: frame(
    "    .-^-.",
    " .-' ✿❀✿ '-.",
    ".' ✿ ❀ ✿ ❀ ✿ '.",
    "  / ✿ ╲│╱ ✿ \\",
    "      ╱│╲",
    "       │",
    "      ╱┴╲",
  ),
  "fall-left": frame(
    "·    .-^-.",
    "  .-' ✿ '-.  ·",
    " .' ✿ ❀ ✿ '.",
    "/ ✿  ╲│╱  ✿ \\",
    "      ╱│╲",
    " ·     │",
    "      ╱┴╲",
  ),
  "fall-right": frame(
    "    .-^-.    ·",
    "· .-' ✿ '-.",
    " .' ✿ ❀ ✿ '. ·",
    "/ ✿  ╲│╱  ✿ \\",
    "      ╱│╲",
    "       │   ·",
    "      ╱┴╲",
  ),
};
