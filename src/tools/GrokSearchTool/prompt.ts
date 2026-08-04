export const GROK_SEARCH_TOOL_NAME = "GrokSearch";

export function getGrokSearchPrompt(): string {
	return [
		"Query Grok for answers grounded in live web search and research, returning the answer with cited sources.",
		"",
		"This is the PREFERRED tool for web research. Use it as your default for current/live information: recent news, real-time facts, current versions/prices/people, or multi-source research that requires browsing the web. Prefer it over WebSearch for general web lookups.",
		"",
		"model:",
		"  - 'fast'   = quick web-search-backed answer (use for most lookups).",
		"  - 'expert' = deeper multi-step research across more sources (use for complex/ambiguous questions needing thorough investigation).",
		"",
		"DO NOT use this for tasks you can already do yourself: reasoning, coding, math, rewriting, or summarizing text already in context. That wastes tokens. This is a web-research tool, not a general-purpose subagent.",
		"",
		"Returns the answer text with inline [n] citation markers, followed by a numbered Sources list (title, site, URL).",
		"",
		"CRITICAL REQUIREMENT - You MUST follow this:",
		"  - After answering the user's question, include the relevant sources from the Sources list as markdown hyperlinks: [Title](URL).",
		"  - Never present Grok's findings as fact without surfacing the sources it cited.",
	].join("\n");
}
