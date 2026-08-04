// HTTP/2 client for the Grok mobile chat API.
import http2 from "node:http2";
import { concat, fieldBool, fieldString, grpcFrame } from "./grokProtobuf.js";
import type { GrokMode } from "./types.js";

const HOST = "https://grok.com";
const PATH = "/grok_api.Chat/CreateConversationAndRespond";
const USER_AGENT = "grok/1.1.82 (Android 16)";

// Request field tags (from reversed CreateConversationAndRespondRequest)
const TAG_TEMPORARY = 3; // bool  -> incognito
const TAG_MESSAGE = 5; // string -> prompt
const TAG_DISABLE_SEARCH = 8; // bool
const TAG_MODE_ID = 60; // string -> "fast" | "expert"

export interface GrokRequestOptions {
	sso: string;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export function buildRequestBody(prompt: string, mode: GrokMode): Uint8Array {
	// temporary=true (always incognito), disable_search=false (search on), mode_id=fast|expert
	return concat(
		fieldBool(TAG_TEMPORARY, true),
		fieldString(TAG_MESSAGE, prompt),
		fieldBool(TAG_DISABLE_SEARCH, false),
		fieldString(TAG_MODE_ID, mode),
	);
}

export interface GrokRawResponse {
	status: number; // grpc-status
	message?: string; // grpc-message
	body: Uint8Array; // concatenated framed payloads
}

export function callGrok(
	prompt: string,
	mode: GrokMode,
	opts: GrokRequestOptions,
): Promise<GrokRawResponse> {
	// The sso cookie doubles as sso-rw — Grok accepts the same value for both.
	const cookie = `sso=${opts.sso}; sso-rw=${opts.sso}`;
	const payload = grpcFrame(buildRequestBody(prompt, mode));
	const timeoutMs = opts.timeoutMs ?? 120_000;

	return new Promise((resolve, reject) => {
		const client = http2.connect(HOST);
		const chunks: Uint8Array[] = [];
		let grpcStatus = 0;
		let grpcMessage: string | undefined;
		let settled = false;

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			try {
				client.close();
			} catch {
				/* noop */
			}
			reject(err);
		};

		client.on("error", fail);

		const req = client.request({
			":method": "POST",
			":path": PATH,
			"content-type": "application/grpc",
			te: "trailers",
			"user-agent": USER_AGENT,
			cookie,
		});

		const timer = setTimeout(
			() => fail(new Error(`Grok request timed out after ${timeoutMs}ms`)),
			timeoutMs,
		);

		// Abort wiring: cancel the in-flight request when the tool's signal fires.
		const onAbort = () => {
			try {
				req.close(http2.constants.NGHTTP2_CANCEL);
			} catch {
				/* noop */
			}
			fail(new Error("Grok request aborted"));
		};
		if (opts.signal) {
			if (opts.signal.aborted) {
				clearTimeout(timer);
				onAbort();
				return;
			}
			opts.signal.addEventListener("abort", onAbort, { once: true });
		}

		req.on("response", (headers) => {
			const s = headers["grpc-status"];
			if (typeof s === "string") grpcStatus = Number.parseInt(s, 10);
			const m = headers["grpc-message"];
			if (typeof m === "string") grpcMessage = decodeURIComponent(m);
		});

		// trailers carry the real grpc-status for streaming responses
		req.on("trailers", (trailers) => {
			const s = trailers["grpc-status"];
			if (typeof s === "string") grpcStatus = Number.parseInt(s, 10);
			const m = trailers["grpc-message"];
			if (typeof m === "string") grpcMessage = decodeURIComponent(m);
		});

		req.on("data", (c: Buffer) => chunks.push(new Uint8Array(c)));

		req.on("end", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
			try {
				client.close();
			} catch {
				/* noop */
			}
			resolve({
				status: grpcStatus,
				message: grpcMessage,
				body: concat(...chunks),
			});
		});

		req.on("error", (err) => {
			clearTimeout(timer);
			fail(err);
		});

		req.write(Buffer.from(payload));
		req.end();
	});
}
