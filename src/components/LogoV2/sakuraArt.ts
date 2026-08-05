export type SakuraPose = "default" | "bloom" | "look-left" | "look-right";

export const SAKURA_WIDTH = 9;
export const SAKURA_HEIGHT = 3;

/** Fixed-width terminal art. Every frame is exactly 9 cells wide and 3 rows high. */
export const SAKURA_ART: Readonly<
  Record<SakuraPose, readonly [string, string, string]>
> = {
  default: ["  .✿.✿.  ", " .✿╲╱✿.  ", "   ║█║   "],
  bloom: [" .✿✿✿.   ", "✿╲╱╲╱✿.  ", "   ║█║   "],
  "look-left": ["·✿.✿.    ", " .✿╲╱✿.  ", "   ║█║   "],
  "look-right": ["   .✿.✿· ", " .✿╲╱✿.  ", "   ║█║   "],
};
