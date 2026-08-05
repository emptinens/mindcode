// Auth helpers for Grok web research (GrokSearch tool + /grok-login command).
// The `sso` session cookie from grok.com is stored plain-text in ~/.mindcode.json.
import { getGlobalConfig, saveGlobalConfig } from "./config.js";

/** The stored Grok `sso` cookie, or undefined if not set / blank. */
export function getGrokSso(): string | undefined {
	return getGlobalConfig().grokSso?.trim() || undefined;
}

/** Persist the Grok `sso` cookie. Trimmed; pass '' to clear. */
export function saveGrokSso(sso: string): void {
	const trimmed = sso.trim();
	saveGlobalConfig((config) => ({
		...config,
		grokSso: trimmed || undefined,
	}));
}

/** True when a Grok `sso` cookie is stored — gates the GrokSearch tool. */
export function isGrokReady(): boolean {
	return getGrokSso() !== undefined;
}
