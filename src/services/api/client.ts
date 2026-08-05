import type { VexzyClient } from "src/services/api/vexzy/protocolTypes.js";
import type { VexzyClientOptions as ClientOptions } from "src/services/api/vexzy/protocolTypes.js";
import { randomUUID } from "node:crypto";
import { assertVexzyApiKey, requireVexzyApiKey } from "./vexzy/config.js";
import type { VexzyFetch } from "./vexzy/messagesClient.js";
import { createVexzySDKAdapter } from "./vexzy/sdkAdapter.js";
import { getUserAgent } from "src/utils/http.js";
import { getSessionId } from "../../bootstrap/state.js";
import { logForDebugging } from "../../utils/debug.js";

const DEFAULT_TIMEOUT_MS = 600 * 1000;

export async function getVexzyClient({
  apiKey,
  maxRetries,
  model,
  fetchOverride,
  source,
}: {
  /** Optional explicit Vexzy credential used by key-verification flows. */
  apiKey?: string;
  maxRetries: number;
  model?: string;
  fetchOverride?: ClientOptions["fetch"];
  source?: string;
}): Promise<VexzyClient> {
  // Native Vexzy owns authentication and validates the credential before any
  // request can be made. Legacy credentials and provider flags are ignored.
  const vexzyApiKey = resolveVexzyApiKey(apiKey);
  void model;

  const defaultHeaders: Record<string, string> = {
    "x-app": "cli",
    "User-Agent": getUserAgent(),
    "X-MindCode-Session-Id": getSessionId(),
    ...(process.env.MINDCODE_CONTAINER_ID
      ? { "x-claude-remote-container-id": process.env.MINDCODE_CONTAINER_ID }
      : {}),
    ...(process.env.MINDCODE_REMOTE_SESSION_ID
      ? { "x-claude-remote-session-id": process.env.MINDCODE_REMOTE_SESSION_ID }
      : {}),
    ...(process.env.MINDCODE_AGENT_SDK_CLIENT_APP
      ? { "x-client-app": process.env.MINDCODE_AGENT_SDK_CLIENT_APP }
      : {}),
  };

  const timeoutMs = parseTimeout(process.env.API_TIMEOUT_MS);
  const adapter = createVexzySDKAdapter({
    apiKey: vexzyApiKey,
    timeoutMs,
    maxRetries,
    fetch: buildFetch(fetchOverride, source, defaultHeaders),
  });

  // getVexzyClient is kept as a compatibility boundary for untouched
  // callers. The native adapter implements the bounded Messages API surface.
  return adapter as unknown as VexzyClient;
}

function resolveVexzyApiKey(explicitApiKey: string | undefined): string {
  if (explicitApiKey === undefined) return requireVexzyApiKey();
  assertVexzyApiKey(explicitApiKey);
  return explicitApiKey;
}

function parseTimeout(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return DEFAULT_TIMEOUT_MS;
  const timeout = Number.parseInt(value, 10);
  return Number.isFinite(timeout) && timeout >= 0
    ? timeout
    : DEFAULT_TIMEOUT_MS;
}

export const CLIENT_REQUEST_ID_HEADER = "x-client-request-id";

function buildFetch(
  fetchOverride: ClientOptions["fetch"],
  source: string | undefined,
  defaultHeaders: Readonly<Record<string, string>>,
): VexzyFetch {
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  const inner = (fetchOverride ?? globalThis.fetch) as VexzyFetch;
  return (input, init) => {
    // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
    const headers = new Headers(defaultHeaders);
    new Headers(init?.headers).forEach((value, name) => {
      headers.set(name, value);
    });

    // Vexzy uses Bearer auth exclusively. The adapter applies the canonical
    // Authorization value after request options are merged.
    headers.delete("x-api-key");

    if (!headers.has(CLIENT_REQUEST_ID_HEADER)) {
      headers.set(CLIENT_REQUEST_ID_HEADER, randomUUID());
    }

    try {
      // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
      const url = input instanceof Request ? input.url : String(input);
      const id = headers.get(CLIENT_REQUEST_ID_HEADER);
      logForDebugging(
        `[API REQUEST] ${new URL(url).pathname}${id ? ` ${CLIENT_REQUEST_ID_HEADER}=${id}` : ""} source=${source ?? "unknown"}`,
      );
    } catch {
      // Request logging must never change request behavior.
    }

    return inner(input, { ...init, headers });
  };
}
