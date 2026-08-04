// Shared types for the GrokSearch tool.

export type GrokMode = "fast" | "expert";

export interface GrokSource {
	index: number; // 1-based citation number
	citationId?: string;
	url: string;
	title?: string;
	siteName?: string;
	preview?: string;
}

export interface GrokResult {
	text: string; // clean answer with [n] markers
	sources: GrokSource[];
	throttled?: boolean;
	error?: string;
}
