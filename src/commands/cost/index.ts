/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 */
import type { Command } from "../../commands.js";

const cost = {
  type: "local",
  name: "cost",
  description: "Show VEXZY credits and token usage for the current session",
  supportsNonInteractive: true,
  load: () => import("./cost.js"),
} satisfies Command;

export default cost;
