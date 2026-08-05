/**
 * Environment variables that control host-owned inference routing and runtime
 * model selection.
 *
 * When MINDCODE_PROVIDER_MANAGED_BY_HOST is truthy in the spawn env, these
 * are stripped from settings-sourced env so the host's routing config isn't
 * overridden by a user's ~/.mindcode/settings.json.
 *
 * New MINDCODE runtime controls should be added here when the host must own
 * their value.
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // The flag itself — settings can't unset it once the host set it
  'MINDCODE_PROVIDER_MANAGED_BY_HOST',
  // Host-owned runtime credentials and model/task controls.
  'VEXZY_API_KEY',
  'MINDCODE_MODEL',
  'MINDCODE_SUBAGENT_MODEL',
  'MINDCODE_COMPACT_MODEL',
  'MINDCODE_EFFORT_LEVEL',
  'MINDCODE_WORKER_EFFORT',
])

export function isProviderManagedEnvVar(key: string): boolean {
  const upper = key.toUpperCase()
  return PROVIDER_MANAGED_ENV_VARS.has(upper)
}

/**
 * Dangerous shell settings that can execute arbitrary shell code
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'otelHeadersHelper',
  'statusLine',
] as const

/**
 * Safe environment variables that can be applied before trust dialog.
 * These are runtime settings that don't pose security risks.
 *
 * IMPORTANT: This is the source of truth for which env vars are safe.
 * Any env var NOT in this list is considered dangerous and will trigger
 * a security dialog when set via remote managed settings.
 *
 * Dangerous env vars (NOT in this list):
 *
 * === REDIRECT TO ATTACKER-CONTROLLED SERVER ===
 * - HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
 * - OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
 *
 * === TRUST ATTACKER-CONTROLLED SERVER ===
 * - NODE_TLS_REJECT_UNAUTHORIZED
 * - NODE_EXTRA_CA_CERTS
 *
 * === SWITCH TO ATTACKER-CONTROLLED PROJECT ===
 * - VEXZY_API_KEY and other credential-shaped variables
 */
export const SAFE_ENV_VARS = new Set([
  'MINDCODE_MODEL',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  'MINDCODE_BASH_MAINTAIN_PROJECT_WORKING_DIR',
  'MINDCODE_API_KEY_HELPER_TTL_MS',
  'MINDCODE_DISABLE_EXPERIMENTAL_BETAS',
  'MINDCODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'MINDCODE_DISABLE_TERMINAL_TITLE',
  'MINDCODE_ENABLE_TELEMETRY',
  'MINDCODE_EXPERIMENTAL_AGENT_TEAMS',
  'MINDCODE_IDE_SKIP_AUTO_INSTALL',
  'MINDCODE_MAX_OUTPUT_TOKENS',
  'MINDCODE_COMPACT_MODEL',
  'MINDCODE_EFFORT_LEVEL',
  'MINDCODE_WORKER_EFFORT',
  'MINDCODE_SUBAGENT_MODEL',
  'DISABLE_AUTOUPDATER',
  'DISABLE_BUG_COMMAND',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'DISABLE_FEEDBACK_COMMAND',
  'DISABLE_TELEMETRY',
  'ENABLE_TOOL_SEARCH',
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  'USE_BUILTIN_RIPGREP',
])
