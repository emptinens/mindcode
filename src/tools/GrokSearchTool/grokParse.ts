// Parses the Grok gRPC streaming response into clean text + sources.
import { asString, decodeMessage, grpcUnframe } from "./grokProtobuf.js";
import type { GrokResult, GrokSource } from "./types.js";

// AddResponseResponse field tags (reversed)
const R_TOKEN = 2; // string streaming delta
const R_WEB_SEARCH_RESULTS = 8;
const R_CITED_WEB_SEARCH_RESULTS = 31;
const R_MESSAGE_TAG = 18; // string: 'header' | 'final' | 'tool_usage_card' | ...
const R_THROTTLE = 54;
const R_MODEL_RESPONSE = 3; // Response (full final turn)

// WebSearchResult field tags
const W_URL = 1;
const W_TITLE = 2;
const W_PREVIEW = 4;
const W_SITE_NAME = 7;

// Response (turn) field tags
const RESP_MESSAGE = 2;

export function parseGrokResponse(body: Uint8Array): GrokResult {
	const frames = grpcUnframe(body);
	const finalTokens: string[] = [];
	const webByUrl = new Map<
		string,
		{ title?: string; preview?: string; siteName?: string }
	>();
	let throttled = false;
	let finalMessage = "";

	for (const frame of frames) {
		const chunk = decodeMessage(frame);
		for (const f of chunk) {
			// chunk.response (tag 1) = AddResponseResponse
			if (f.tag !== 1 || !(f.value instanceof Uint8Array)) continue;
			const resp = decodeMessage(f.value);

			let token: string | undefined;
			let messageTag: string | undefined;

			for (const rf of resp) {
				if (rf.tag === R_TOKEN && rf.value instanceof Uint8Array) {
					token = asString(rf.value);
				} else if (rf.tag === R_MESSAGE_TAG && rf.value instanceof Uint8Array) {
					messageTag = asString(rf.value);
				} else if (
					(rf.tag === R_WEB_SEARCH_RESULTS ||
						rf.tag === R_CITED_WEB_SEARCH_RESULTS) &&
					rf.value instanceof Uint8Array
				) {
					collectWebResults(rf.value, webByUrl);
				} else if (rf.tag === R_THROTTLE) {
					throttled = true;
				} else if (
					rf.tag === R_MODEL_RESPONSE &&
					rf.value instanceof Uint8Array
				) {
					const turn = decodeMessage(rf.value);
					for (const tf of turn) {
						if (tf.tag === RESP_MESSAGE && tf.value instanceof Uint8Array) {
							finalMessage = asString(tf.value);
						}
					}
				}
			}

			// Only the 'final' message stream is the actual answer.
			if (token !== undefined && messageTag === "final") {
				finalTokens.push(token);
			}
		}
	}

	// card_id -> url, scanned from the whole body (card JSON lives outside token fields)
	const cardUrls = scanCardUrls(body);

	const rawAnswer = finalTokens.join("") || finalMessage;
	const { text, sources } = renderCitations(rawAnswer, cardUrls, webByUrl);

	return { text: text.trim(), sources, throttled };
}

function collectWebResults(
	buf: Uint8Array,
	out: Map<string, { title?: string; preview?: string; siteName?: string }>,
): void {
	// WebSearchResults: repeated WebSearchResult at tag 1
	const fields = decodeMessage(buf);
	for (const f of fields) {
		if (f.tag !== 1 || !(f.value instanceof Uint8Array)) continue;
		const wr = decodeMessage(f.value);
		let url = "";
		let title: string | undefined;
		let preview: string | undefined;
		let siteName: string | undefined;
		for (const x of wr) {
			if (!(x.value instanceof Uint8Array)) continue;
			const s = asString(x.value);
			if (x.tag === W_URL) url = s;
			else if (x.tag === W_TITLE) title = s;
			else if (x.tag === W_PREVIEW) preview = s;
			else if (x.tag === W_SITE_NAME) siteName = s;
		}
		if (url && !out.has(url)) out.set(url, { title, preview, siteName });
	}
}

// Scan the entire response body for citation-card JSON objects:
// {"id":"4e7b64","type":"render_inline_citation","cardType":"citation_card","url":"https://..."}
function scanCardUrls(body: Uint8Array): Map<string, string> {
	const map = new Map<string, string>();
	// latin1 keeps every byte 1:1; URLs/ids are ASCII so this is safe for the regex.
	const s = Buffer.from(body).toString("latin1");
	const re = /\{"id":"([^"]+)"[^}]*?"url":"([^"]+)"\}/g;
	let m: RegExpExecArray | null = re.exec(s);
	while (m !== null) {
		if (!map.has(m[1])) map.set(m[1], m[2]);
		m = re.exec(s);
	}
	return map;
}

function hostname(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

// Rewrites inline <grok:render> markers to sequential [1],[2],... and builds
// a matching sources list in the same order, appending any uncited web results.
function renderCitations(
	raw: string,
	cardUrls: Map<string, string>,
	webByUrl: Map<
		string,
		{ title?: string; preview?: string; siteName?: string }
	>,
): { text: string; sources: GrokSource[] } {
	// url -> assigned display index
	const urlToIndex = new Map<string, number>();
	const sources: GrokSource[] = [];

	const assign = (url: string): number => {
		let idx = urlToIndex.get(url);
		if (idx !== undefined) return idx;
		idx = sources.length + 1;
		urlToIndex.set(url, idx);
		const enrich = webByUrl.get(url);
		sources.push({
			index: idx,
			url,
			title: enrich?.title,
			siteName: enrich?.siteName ?? hostname(url),
			preview: enrich?.preview,
		});
		return idx;
	};

	// Replace each grok:render marker with [N], assigning N by first appearance.
	const renderRe =
		/<grok:render\s+card_id="([^"]+)"[^>]*>[\s\S]*?<\/grok:render>/g;
	let text = raw.replace(renderRe, (_full, cardId: string) => {
		const url = cardUrls.get(cardId);
		if (!url) return ""; // unknown card -> drop marker
		return `[${assign(url)}]`;
	});

	// Strip any residual markup that may appear in the final stream.
	text = text.replace(
		/<xai:tool_usage_card>[\s\S]*?<\/xai:tool_usage_card>/g,
		"",
	);
	text = text.replace(/\{"id":"[^"]+"[^}]*?"url":"[^"]+"\}/g, "");
	text = text.replace(/<\/?xai:[^>]*>/g, "");
	text = text.replace(/<\/?grok:[^>]*>/g, "");
	// Collapse consecutive duplicate citation markers, e.g. "[1][1]" -> "[1]".
	text = text.replace(/(\[\d+\])(\1)+/g, "$1");
	text = text.replace(/\n{3,}/g, "\n\n");

	// Only cited sources are returned. Grok's web_search_results often contain
	// extra results from internal queries that the answer never references
	// (e.g. generic "latest news" hits); including them as citations is noise.
	return { text, sources };
}
