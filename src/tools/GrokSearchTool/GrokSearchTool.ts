import type { PermissionResult } from "src/utils/permissions/PermissionResult.js";
import { z } from "zod/v4";
import { type ToolDef, buildTool } from "../../Tool.js";
import { getGrokSso, isGrokReady } from "../../utils/grokAuth.js";
import { lazySchema } from "../../utils/lazySchema.js";
import {
	getToolUseSummary,
	renderToolResultMessage,
	renderToolUseMessage,
} from "./UI.js";
import { callGrok } from "./grokClient.js";
import { parseGrokResponse } from "./grokParse.js";
import { GROK_SEARCH_TOOL_NAME, getGrokSearchPrompt } from "./prompt.js";
import type { GrokMode, GrokSource } from "./types.js";

const inputSchema = lazySchema(() =>
	z.strictObject({
		model: z
			.enum(["fast", "expert"])
			.describe(
				"'fast' for quick web-search answers; 'expert' for deeper multi-step research.",
			),
		prompt: z
			.string()
			.min(2)
			.describe("The question or research request to send to Grok."),
	}),
);
type InputSchema = ReturnType<typeof inputSchema>;
type Input = z.infer<InputSchema>;

const outputSchema = lazySchema(() =>
	z.object({
		answer: z.string().describe("Grok answer text with inline [n] markers"),
		sources: z
			.array(
				z.object({
					index: z.number(),
					url: z.string(),
					title: z.string().optional(),
					siteName: z.string().optional(),
					preview: z.string().optional(),
				}),
			)
			.describe("Cited sources, in citation order"),
		model: z.enum(["fast", "expert"]).describe("The Grok mode that was used"),
		durationSeconds: z
			.number()
			.describe("Time taken to complete the Grok request"),
	}),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type Output = z.infer<OutputSchema>;

function formatSources(sources: GrokSource[]): string {
	if (!sources.length) return "";
	const lines = sources.map((s) => {
		const title = s.title?.trim() || s.siteName?.trim() || s.url;
		const site = s.siteName?.trim();
		const head = site && site !== title ? `${title} — ${site}` : title;
		const preview = s.preview?.trim() ? `\n     ${s.preview.trim()}` : "";
		return `[${s.index}] ${head}\n     ${s.url}${preview}`;
	});
	return `\n\n---\nSources:\n${lines.join("\n")}`;
}

export const GrokSearchTool = buildTool({
	name: GROK_SEARCH_TOOL_NAME,
	searchHint: "grok web search research with cited sources",
	maxResultSizeChars: 100_000,
	// Always-loaded (not deferred): the model must see GrokSearch's full schema
	// in the initial prompt so it can reach for web research without a
	// ToolSearch round-trip — and pick it over the deferred WebSearch.
	alwaysLoad: true,
	async description(input) {
		return `Claude wants to research with Grok: ${input.prompt}`;
	},
	userFacingName() {
		return "Grok Search";
	},
	getToolUseSummary,
	getActivityDescription(input) {
		const summary = getToolUseSummary(input);
		return summary ? `Researching ${summary}` : "Researching with Grok";
	},
	// Hide the tool entirely unless the user has signed in via /grok-login.
	isEnabled() {
		return isGrokReady();
	},
	get inputSchema(): InputSchema {
		return inputSchema();
	},
	get outputSchema(): OutputSchema {
		return outputSchema();
	},
	isConcurrencySafe() {
		return true;
	},
	isReadOnly() {
		return true;
	},
	toAutoClassifierInput(input) {
		return `${input.model}: ${input.prompt}`;
	},
	async checkPermissions(_input): Promise<PermissionResult> {
		return {
			behavior: "passthrough",
			message: "GrokSearch requires permission.",
			suggestions: [
				{
					type: "addRules",
					rules: [{ toolName: GROK_SEARCH_TOOL_NAME }],
					behavior: "allow",
					destination: "localSettings",
				},
			],
		};
	},
	async prompt() {
		return getGrokSearchPrompt();
	},
	renderToolUseMessage,
	renderToolResultMessage,
	async call(input, context) {
		const startTime = performance.now();
		const { model, prompt } = input;

		const sso = getGrokSso();
		if (!sso) {
			throw new Error(
				"Not signed in to Grok. Run /grok-login and paste your grok.com `sso` cookie to enable Grok web research.",
			);
		}

		const raw = await callGrok(prompt, model as GrokMode, {
			sso,
			signal: context.abortController.signal,
		});

		if (raw.status === 16) {
			throw new Error(
				`Grok auth failed (${raw.message ?? "bad credentials"}). The stored sso cookie is likely expired — re-run /grok-login.`,
			);
		}
		if (raw.status !== 0) {
			throw new Error(
				`Grok returned grpc-status ${raw.status}: ${raw.message ?? "unknown error"}`,
			);
		}

		const result = parseGrokResponse(raw.body);

		if (result.throttled) {
			throw new Error(
				"Grok rate-limited this request (throttle). Try again later or slow down.",
			);
		}
		if (!result.text) {
			throw new Error("Grok returned an empty response.");
		}

		const durationSeconds = (performance.now() - startTime) / 1000;

		return {
			data: {
				answer: result.text,
				sources: result.sources,
				model: model as GrokMode,
				durationSeconds,
			},
		};
	},
	mapToolResultToToolResultBlockParam(output, toolUseID) {
		const body = output.answer + formatSources(output.sources);
		return {
			tool_use_id: toolUseID,
			type: "tool_result",
			content: `${body}\n\nREMINDER: Surface the sources above in your response as markdown hyperlinks.`,
		};
	},
} satisfies ToolDef<InputSchema, Output>);
