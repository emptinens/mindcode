import type { Command } from "../../commands.js";

export default {
	type: "local-jsx",
	name: "grok-login",
	description: "Sign in to Grok for web research (paste your sso cookie)",
	// Args (the pasted cookie) are redacted from conversation history.
	isSensitive: true,
	load: () => import("./grok-login.js"),
} satisfies Command;
