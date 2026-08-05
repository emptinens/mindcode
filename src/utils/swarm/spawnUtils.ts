/**
 * Shared utilities for spawning teammates across different backends.
 */

import {
  getFlagSettingsPath,
  getInlinePlugins,
  getMainLoopModelOverride,
  getSessionBypassPermissionsMode,
} from '../../bootstrap/state.js'
import { quote } from '../bash/shellQuote.js'
import { isInBundledMode } from '../bundledMode.js'
import {
  JAILBREAK_LEVEL_ENV_VAR,
  type JailbreakLevel,
  getJailbreakLevel,
  parseJailbreakLevel,
} from '../jailbreak.js'
import { getConfiguredSubagentModel } from '../model/subagentModel.js'
import type { PermissionMode } from '../permissions/PermissionMode.js'
import { getTeammateModeFromSnapshot } from './backends/teammateModeSnapshot.js'
import { TEAMMATE_COMMAND_ENV_VAR } from './constants.js'

/**
 * Gets the command to use for spawning teammate processes.
 * Uses TEAMMATE_COMMAND_ENV_VAR if set, otherwise falls back to the
 * current process executable path.
 */
export function getTeammateCommand(): string {
  if (process.env[TEAMMATE_COMMAND_ENV_VAR]) {
    return process.env[TEAMMATE_COMMAND_ENV_VAR]
  }
  return isInBundledMode() ? process.execPath : process.argv[1]!
}

/**
 * Builds CLI flags to propagate from the current session to spawned teammates.
 * This ensures teammates inherit important settings like permission mode,
 * model selection, and plugin configuration from their parent.
 *
 * @param options.planModeRequired - If true, don't inherit bypass permissions (plan mode takes precedence)
 * @param options.permissionMode - Permission mode to propagate
 */
export function buildInheritedCliFlags(options?: {
  planModeRequired?: boolean
  permissionMode?: PermissionMode
}): string {
  const flags: string[] = []
  const { planModeRequired, permissionMode } = options || {}

  // Propagate permission mode to teammates, but NOT if plan mode is required
  // Plan mode takes precedence over bypass permissions for safety
  if (planModeRequired) {
    // Don't inherit bypass permissions when plan mode is required
  } else if (
    permissionMode === 'bypassPermissions' ||
    getSessionBypassPermissionsMode()
  ) {
    flags.push('--dangerously-skip-permissions')
  } else if (permissionMode === 'acceptEdits') {
    flags.push('--permission-mode acceptEdits')
  }

  // Propagate --model if explicitly set via CLI
  const modelOverride = getMainLoopModelOverride()
  if (modelOverride) {
    flags.push(`--model ${quote([modelOverride])}`)
  }

  // Propagate --settings if set via CLI
  const settingsPath = getFlagSettingsPath()
  if (settingsPath) {
    flags.push(`--settings ${quote([settingsPath])}`)
  }

  // Propagate --plugin-dir for each inline plugin
  const inlinePlugins = getInlinePlugins()
  for (const pluginDir of inlinePlugins) {
    flags.push(`--plugin-dir ${quote([pluginDir])}`)
  }

  // Propagate --teammate-mode so tmux teammates use the same mode as leader
  const sessionMode = getTeammateModeFromSnapshot()
  flags.push(`--teammate-mode ${sessionMode}`)


  return flags.join(' ')
}

/**
 * Environment variables that must be explicitly forwarded to tmux-spawned
 * teammates. Tmux may start a new login shell that doesn't inherit the
 * parent's env, so we forward any that are set in the current process.
 */
const TEAMMATE_ENV_VARS = [
  // VEXZY credentials/model selection and subagent behavior. tmux may start
  // a fresh login shell, so these must be forwarded explicitly.
  'VEXZY_API_KEY',
  'MINDCODE_MODEL',
  'MINDCODE_SUBAGENT_MODEL',
  'MINDCODE_COMPACT_MODEL',
  'MINDCODE_WORKER_EFFORT',
  'MINDCODE_DISABLE_COMPACT_CACHE_SHARING',
  // Config directory override
  'MINDCODE_CONFIG_DIR',
  // CCR marker — teammates need this for CCR-aware code paths. Auth finds
  // its own way via /home/claude/.mindcode/remote/.oauth_token regardless;
  // the FD env var wouldn't help (pipe FDs don't cross tmux).
  'MINDCODE_REMOTE',
  // Auto-memory gate (memdir/paths.ts) checks REMOTE && !MEMORY_DIR to
  // disable memory on ephemeral CCR filesystems. Forwarding REMOTE alone
  // would flip teammates to memory-off when the parent has it on.
  'MINDCODE_REMOTE_MEMORY_DIR',
  // Upstream proxy — the parent's MITM relay is reachable from teammates
  // (same container network). Forward the proxy vars so teammates route
  // customer-configured upstream traffic through the relay for credential
  // injection. Without these, teammates bypass the proxy entirely.
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE',
] as const

export function isTeammateEnvVarForwarded(name: string): boolean {
  return (
    name === JAILBREAK_LEVEL_ENV_VAR ||
    (TEAMMATE_ENV_VARS as readonly string[]).includes(name)
  )
}

/**
 * Builds the `env KEY=VALUE ...` string for teammate spawn commands.
 * Always includes MINDCODE=1 and MINDCODE_EXPERIMENTAL_AGENT_TEAMS=1,
 * plus any runtime/config env vars that are set in the current process.
 */
export function buildInheritedEnvVars(
  jailbreakLevel: JailbreakLevel = getJailbreakLevel(),
): string {
  // Always derive this value from the validated enum, never from the raw
  // parent environment. This makes pane-worker propagation deterministic and
  // prevents shell metacharacters or secrets from entering the spawn command.
  const normalizedJailbreakLevel =
    parseJailbreakLevel(String(jailbreakLevel)) ?? getJailbreakLevel()
  const envVars = [
    'MINDCODE=1',
    'MINDCODE_EXPERIMENTAL_AGENT_TEAMS=1',
    `${JAILBREAK_LEVEL_ENV_VAR}=${quote([normalizedJailbreakLevel])}`,
  ]

  for (const key of TEAMMATE_ENV_VARS) {
    const value =
      key === 'MINDCODE_MODEL' ? getConfiguredSubagentModel() : process.env[key]
    if (value !== undefined && value !== '') {
      envVars.push(`${key}=${quote([value])}`)
    }
  }

  return envVars.join(' ')
}
