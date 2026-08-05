import { isEnvTruthy } from './envUtils.js'

/**
 * Env vars to strip from subprocess environments when running inside GitHub
 * Actions. This prevents prompt-injection attacks from exfiltrating secrets
 * via shell expansion in Bash tool commands.
 *
 * The parent process keeps its runtime credential for API calls. Only child
 * processes (bash, shell snapshot, MCP stdio, LSP, hooks) are scrubbed.
 *
 * GITHUB_TOKEN / GH_TOKEN are intentionally NOT scrubbed — wrapper scripts
 * (gh.sh) need them to call the GitHub API. That token is job-scoped and
 * expires when the workflow ends.
 */
const EXPLICIT_SUBPROCESS_SCRUB = new Set([
  // OTLP exporter headers — documented to carry Authorization=Bearer tokens
  // for monitoring backends; read in-process by OTEL SDK, subprocesses never need them
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // GitHub Actions OIDC — consumed by the action's JS before claude spawns;
  // leaking these allows minting an App installation token → repo takeover
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',

  // GitHub Actions artifact/cache API — cache poisoning → supply-chain pivot
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // Action-specific duplicates — action JS consumes these during prepare,
  // before spawning the runtime.
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
])

/**
 * Credential-shaped names are scrubbed without maintaining a provider list.
 * This covers newly introduced provider credentials and GitHub Actions'
 * INPUT_<NAME> copies while allowing the VEXZY runtime credential through to
 * workers explicitly below.
 */
const SENSITIVE_ENV_NAME =
  /(?:^|_)(?:API_KEY|AUTH_TOKEN|OAUTH_TOKEN|ACCESS_TOKEN|ACCESS_KEY|BEARER_TOKEN|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CREDENTIALS?|CERTIFICATE|AUTHORIZATION|CUSTOM_HEADERS)(?:$|_)/i

const PRESERVED_RUNTIME_ENV = new Set([
  'VEXZY_API_KEY',
  'GITHUB_TOKEN',
  'GH_TOKEN',
])

function shouldScrubSubprocessEnvKey(key: string): boolean {
  if (PRESERVED_RUNTIME_ENV.has(key)) return false
  return EXPLICIT_SUBPROCESS_SCRUB.has(key) || SENSITIVE_ENV_NAME.test(key)
}

/**
 * Returns a copy of process.env with sensitive secrets stripped, for use when
 * spawning subprocesses (Bash tool, shell snapshot, MCP stdio servers, LSP
 * servers, shell hooks).
 *
 * Gated on MINDCODE_SUBPROCESS_ENV_SCRUB. mindcode-action sets this
 * automatically when `allowed_non_write_users` is configured — the flag that
 * exposes a workflow to untrusted content (prompt injection surface).
 */
// Registered by init.ts after the upstreamproxy module is dynamically imported
// in CCR sessions. Stays undefined in non-CCR startups so we never pull in the
// upstreamproxy module graph via a static import.
let _getUpstreamProxyEnv: (() => Record<string, string>) | undefined

/**
 * Called from init.ts to wire up the proxy env function after the upstreamproxy
 * module has been lazily loaded. Must be called before any subprocess is spawned.
 */
export function registerUpstreamProxyEnvFn(
  fn: () => Record<string, string>,
): void {
  _getUpstreamProxyEnv = fn
}

export function subprocessEnv(): NodeJS.ProcessEnv {
  // CCR upstreamproxy: inject HTTPS_PROXY + CA bundle vars so curl/gh/python
  // in agent subprocesses route through the local relay. Returns {} when the
  // proxy is disabled or not registered (non-CCR), so this is a no-op outside
  // CCR containers.
  const proxyEnv = _getUpstreamProxyEnv?.() ?? {}

  if (!isEnvTruthy(process.env.MINDCODE_SUBPROCESS_ENV_SCRUB)) {
    return Object.keys(proxyEnv).length > 0
      ? { ...process.env, ...proxyEnv }
      : process.env
  }
  const env = { ...process.env, ...proxyEnv }
  for (const key of Object.keys(env)) {
    if (shouldScrubSubprocessEnvKey(key)) {
      delete env[key]
    }
  }
  for (const key of EXPLICIT_SUBPROCESS_SCRUB) {
    // GitHub Actions auto-creates INPUT_<NAME> for `with:` inputs. No-op for
    // vars that are not action inputs.
    delete env[`INPUT_${key}`]
  }
  // VEXZY workers require the runtime credential to reach the fixed endpoint.
  // Preserve the value explicitly without ever formatting or logging it.
  if (process.env.VEXZY_API_KEY !== undefined) {
    env.VEXZY_API_KEY = process.env.VEXZY_API_KEY
  }
  return env
}
