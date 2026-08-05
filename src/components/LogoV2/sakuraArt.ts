export type SakuraPose = "default" | "bloom" | "look-left" | "look-right";

export const SAKURA_WIDTH = 17;
export const SAKURA_HEIGHT = 6;

export type SakuraFrame = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Fixed-width Unicode art. Every frame is exactly 17 cells by 6 rows. */
export const SAKURA_ART: Readonly<Record<SakuraPose, SakuraFrame>> = {
  default: [
    "      ·   ❀      ",
    "    · ❀ ✿ ❀ ·    ",
    "   ❀ ✿╲✿╱✿ ❀  ·  ",
    "   ╲ ╲│╱ ╱   ❀   ",
    "        │        ",
    "       ╱┴╲       ",
  ],
  bloom: [
    "      ❀ · ❀      ",
    "    ❀ ✿ ❀ ✿ ❀    ",
    "   ✿ ❀╲✿╱❀ ✿ ❀   ",
    "    ╲ ╲│╱ ╱  ·   ",
    "        │        ",
    "       ╱┴╲       ",
  ],
  "look-left": [
    "      ❀   ·      ",
    "    · ❀ ✿ ❀ ·    ",
    "   ❀ ✿╲✿╱✿ ❀  ·  ",
    "    ❀  ╲ ╲│╱ ╱   ",
    "        │        ",
    "       ╱┴╲       ",
  ],
  "look-right": [
    "      ·   ❀      ",
    "    · ❀ ✿ ❀ ·    ",
    "   ·  ❀ ✿╲✿╱✿ ❀  ",
    "    ╲ ╲│╱ ╱  ❀   ",
    "        │        ",
    "       ╱┴╲       ",
  ],
};
