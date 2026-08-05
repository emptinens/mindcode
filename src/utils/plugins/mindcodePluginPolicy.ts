/**
 * MindCode's built-in component policy. This is deliberately a pure name
 * policy: it never reads or writes user configuration and never contains
 * credentials. External settings remain intact; disallowed components are
 * simply not loaded into the runtime.
 */
export const MINDCODE_ALLOWED_PLUGIN_ALIASES = [
  'ida',
  'superpowers',
  'math-mcp',
] as const

export type MindCodeAllowedPlugin =
  (typeof MINDCODE_ALLOWED_PLUGIN_ALIASES)[number]

const ALIASES: Record<string, MindCodeAllowedPlugin> = {
  ida: 'ida',
  idamcp: 'ida',
  'ida-mcp': 'ida',
  'ida-pro-mcp': 'ida',
  superpowers: 'superpowers',
  math: 'math-mcp',
  'math-mcp': 'math-mcp',
  mathmcp: 'math-mcp',
}

/** Normalize plugin/server labels without changing persisted names. */
export function normalizeMindCodePolicyName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/g, '-')
}

/** Resolve an allowed alias from a plugin ID, manifest name, or server name. */
export function resolveMindCodeAllowedAlias(
  value: string,
): MindCodeAllowedPlugin | undefined {
  const normalized = normalizeMindCodePolicyName(value)
  const parts = normalized.split('@')
  if (parts.length > 2) return undefined
  const base = parts[0] ?? ''

  // This is the factual marketplace identifier. Do not treat an arbitrary
  // marketplace suffix as an IDA alias; aliases without a marketplace suffix
  // remain valid for local/builtin registrations.
  if (
    base === 'ida-pro-mcp' &&
    parts.length === 2 &&
    parts[1] !== 'mrexodia'
  ) {
    return undefined
  }
  return ALIASES[base]
}

export type MindCodePluginPolicyDecision = {
  allowed: boolean
  alias?: MindCodeAllowedPlugin
  reason: string
}

export type MindCodeMcpPolicyDecision = MindCodePluginPolicyDecision & {
  /** The allowlisted plugin that owns the server, when the server is plugin-provided. */
  pluginAlias?: MindCodeAllowedPlugin
}

/** Diagnostic decision used by both plugin and MCP loading paths. */
export function evaluateMindCodePluginPolicy(
  pluginIdOrName: string,
): MindCodePluginPolicyDecision {
  const alias = resolveMindCodeAllowedAlias(pluginIdOrName)
  if (alias) {
    return { allowed: true, alias, reason: `allowlisted as ${alias}` }
  }
  return {
    allowed: false,
    reason: `not in MindCode allowlist (${MINDCODE_ALLOWED_PLUGIN_ALIASES.join(', ')})`,
  }
}

/**
 * Evaluate an MCP server without mutating its source configuration.
 *
 * Plugin-provided servers inherit the decision of their owning plugin. For
 * user/project/local/enterprise MCP entries there is no owning plugin, so the
 * server name itself must be one of the documented allowlist names. This is
 * intentionally a pure function: callers skip blocked entries at runtime and
 * leave the user's config files untouched.
 */
export function evaluateMindCodeMcpPolicy(
  serverName: string,
  pluginSource?: string,
): MindCodeMcpPolicyDecision {
  if (pluginSource) {
    const pluginDecision = evaluateMindCodePluginPolicy(pluginSource)
    if (pluginDecision.allowed) {
      return {
        allowed: true,
        alias: pluginDecision.alias,
        pluginAlias: pluginDecision.alias,
        reason: `provided by allowlisted plugin ${pluginDecision.alias}`,
      }
    }
    return {
      allowed: false,
      reason: `owning plugin "${pluginSource}" is blocked: ${pluginDecision.reason}`,
    }
  }

  const serverDecision = evaluateMindCodePluginPolicy(serverName)
  if (serverDecision.allowed) {
    return {
      allowed: true,
      alias: serverDecision.alias,
      reason: `MCP server name is allowlisted as ${serverDecision.alias}`,
    }
  }
  return {
    allowed: false,
    reason: `MCP server "${serverName}" is not an allowlisted plugin/MCP (${MINDCODE_ALLOWED_PLUGIN_ALIASES.join(', ')})`,
  }
}

export type MindCodeMcpPolicySkip = {
  name: string
  reason: string
}

/** Filter runtime MCP entries while preserving the caller's source record. */
export function filterMindCodeMcpEntries<T>(
  entries: Record<string, T>,
  getPluginSource: (entry: T) => string | undefined = entry =>
    (entry as { pluginSource?: string }).pluginSource,
): {
  allowed: Record<string, T>
  blocked: MindCodeMcpPolicySkip[]
} {
  const allowed: Record<string, T> = {}
  const blocked: MindCodeMcpPolicySkip[] = []
  for (const [name, entry] of Object.entries(entries)) {
    const decision = evaluateMindCodeMcpPolicy(name, getPluginSource(entry))
    if (decision.allowed) {
      allowed[name] = entry
    } else {
      blocked.push({ name, reason: decision.reason })
    }
  }
  return { allowed, blocked }
}

/** Stable human-readable diagnostic for /mcp and /plugin integrations. */
export function getMindCodePluginPolicyDiagnostic(): {
  mode: 'allowlist'
  allowed: readonly string[]
  aliases: Record<string, MindCodeAllowedPlugin>
  externalSettings: 'preserved'
} {
  return {
    mode: 'allowlist',
    allowed: MINDCODE_ALLOWED_PLUGIN_ALIASES,
    aliases: {
      ida: 'ida',
      idamcp: 'ida',
      'ida-mcp': 'ida',
      'ida-pro-mcp': 'ida',
      'ida-pro-mcp@mrexodia': 'ida',
      superpowers: 'superpowers',
      math: 'math-mcp',
      'math-mcp': 'math-mcp',
      mathmcp: 'math-mcp',
    },
    externalSettings: 'preserved',
  }
}
