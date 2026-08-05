/**
 * Preconnect to the fixed VEXZY Messages origin to overlap TCP+TLS handshake
 * with startup.
 *
 * The TCP+TLS handshake is ~100-200ms that normally blocks inside the first
 * API call. Kicking a fire-and-forget fetch during init lets the handshake
 * happen in parallel with action-handler work (~100ms of setup/commands/mcp
 * before the API request in -p mode; unbounded "user is typing" window in
 * interactive mode).
 *
 * Bun's fetch shares a keep-alive connection pool globally, so the real API
 * request reuses the warmed connection.
 *
 * Called from init.ts AFTER applyExtraCACertsFromConfig() + configureGlobalAgents()
 * so settings.json env vars are applied and the TLS cert store is finalized.
 * The early cli.tsx call site was removed — it ran before settings.json loaded,
 * so proxy/mTLS settings would be invisible and preconnect could warm the
 * wrong pool.
 *
 * Skipped when:
 * - proxy/mTLS/unix socket configured (preconnect would use wrong transport —
 *   the SDK passes a custom dispatcher/agent that doesn't share the global pool)
 */

import { VEXZY_MESSAGES_BASE_URL } from '../services/api/vexzy/config.js'

let fired = false

export function preconnectVexzyApi(): void {
  if (fired) return
  fired = true

  // Skip if proxy or mTLS is configured: the request client may use a custom
  // dispatcher that does not share Bun's global keep-alive pool.
  if (
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy ||
    process.env.MINDCODE_CLIENT_CERT ||
    process.env.MINDCODE_CLIENT_KEY
  ) {
    return
  }

  // Fire and forget. HEAD means no response body — the connection is eligible
  // for keep-alive pool reuse immediately after headers arrive. 10s timeout
  // so a slow network doesn't hang the process; abort is fine since the real
  // request will handshake fresh if needed.
  // eslint-disable-next-line eslint-plugin-n/no-unsupported-features/node-builtins
  void fetch(VEXZY_MESSAGES_BASE_URL, {
    method: 'HEAD',
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {})
}
