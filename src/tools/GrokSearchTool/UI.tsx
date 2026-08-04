import type React from "react";
import { MessageResponse } from "../../components/MessageResponse.js";
import { TOOL_SUMMARY_MAX_LENGTH } from "../../constants/toolLimits.js";
import { Box, Text } from "../../ink.js";
import { truncate } from "../../utils/format.js";
import type { Output } from "./GrokSearchTool.js";
import type { GrokMode } from "./types.js";

export function renderToolUseMessage(
	{ model, prompt }: Partial<{ model: GrokMode; prompt: string }>,
	{ verbose }: { verbose: boolean },
): React.ReactNode {
	if (!prompt) {
		return null;
	}
	const label = model ? `[${model}] ` : "";
	const shown = verbose ? prompt : truncate(prompt, TOOL_SUMMARY_MAX_LENGTH);
	return `${label}"${shown}"`;
}

export function renderToolResultMessage(output: Output): React.ReactNode {
	const sourceCount = output.sources?.length ?? 0;
	const timeDisplay =
		output.durationSeconds >= 1
			? `${Math.round(output.durationSeconds)}s`
			: `${Math.round(output.durationSeconds * 1000)}ms`;
	return (
		<Box justifyContent="space-between" width="100%">
			<MessageResponse height={1}>
				<Text>
					Grok answered in {timeDisplay} · {sourceCount} source
					{sourceCount !== 1 ? "s" : ""}
				</Text>
			</MessageResponse>
		</Box>
	);
}

export function getToolUseSummary(
	input: Partial<{ prompt: string }> | undefined,
): string | null {
	if (!input?.prompt) {
		return null;
	}
	return truncate(input.prompt, TOOL_SUMMARY_MAX_LENGTH);
}
