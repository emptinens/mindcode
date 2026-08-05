import type React from "react";
import { useState } from "react";
import type { LocalJSXCommandContext } from "../../commands.js";
import { ConfigurableShortcutHint } from "../../components/ConfigurableShortcutHint.js";
import TextInput from "../../components/TextInput.js";
import { Dialog } from "../../components/design-system/Dialog.js";
import { useTerminalSize } from "../../hooks/useTerminalSize.js";
import { Box, Text } from "../../ink.js";
import type { LocalJSXCommandOnDone } from "../../types/command.js";
import { saveGrokSso } from "../../utils/grokAuth.js";

export async function call(
	onDone: LocalJSXCommandOnDone,
	context: LocalJSXCommandContext,
): Promise<React.ReactNode> {
	return (
		<GrokLogin
			onDone={(saved) => {
				if (saved) {
					// Bump authVersion so auth-dependent state (the tool list) re-derives
					// this turn — GrokSearch appears immediately without a restart.
					context.setAppState((prev) => ({
						...prev,
						authVersion: prev.authVersion + 1,
					}));
				}
				onDone(
					saved
						? "Grok login saved — web research enabled"
						: "Grok login cancelled",
				);
			}}
		/>
	);
}

function GrokLogin({
	onDone,
}: {
	onDone: (saved: boolean) => void;
}): React.ReactNode {
	const [value, setValue] = useState("");
	const [cursorOffset, setCursorOffset] = useState(0);
	const { columns } = useTerminalSize();

	const handleSubmit = () => {
		const sso = value.trim();
		if (!sso) {
			onDone(false);
			return;
		}
		saveGrokSso(sso);
		onDone(true);
	};

	return (
		<Dialog
			title="Grok Login"
			subtitle={'Paste your grok.com "sso" session cookie:'}
			color="permission"
			onCancel={() => onDone(false)}
			inputGuide={(exitState) =>
				exitState.pending ? (
					<Text>Press {exitState.keyName} again to exit</Text>
				) : (
					<ConfigurableShortcutHint
						action="confirm:no"
						context="Confirmation"
						fallback="Esc"
						description="cancel"
					/>
				)
			}
		>
			<Box flexDirection="column">
				<Box flexDirection="row" gap={1} marginTop={1}>
					<Text>&gt;</Text>
					<TextInput
						value={value}
						onChange={setValue}
						onSubmit={handleSubmit}
						mask="*"
						focus={true}
						showCursor={true}
						columns={columns}
						cursorOffset={cursorOffset}
						onChangeCursorOffset={setCursorOffset}
					/>
				</Box>
				<Box marginTop={1}>
					<Text dimColor>
						Get it from grok.com → DevTools → Application → Cookies → the
						"sso" value (a long JWT starting with eyJ…). Stored in
						~/.mindcode.json.
					</Text>
				</Box>
			</Box>
		</Dialog>
	);
}
