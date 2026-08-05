import type { Command } from "../../commands.js";

const copycon = {
  type: "local-jsx",
  name: "copycon",
  description:
    "Generate a portable Russian continuation prompt with GPT-5.6 Luna and copy it",
  argumentHint: "[optional focus or handoff instructions]",
  immediate: true,
  load: () => import("./copycon.js"),
} satisfies Command;

export default copycon;
