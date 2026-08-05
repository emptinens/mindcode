/**
 * Local manifest contract for bundled MCP extensions.
 *
 * This deliberately contains only the fields MindCode consumes. Keeping the
 * contract local avoids making plugin loading dependent on a vendor schema
 * package while preserving compatibility with existing bundle manifests.
 */
export type McpbUserConfigurationOption = {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file'
  title: string
  description: string
  required?: boolean
  default?: string | number | boolean | string[]
  multiple?: boolean
  sensitive?: boolean
  min?: number
  max?: number
}

export type McpbAuthor = {
  name: string
  email?: string
  url?: string
}

export type McpbServer = {
  type?: 'node' | 'python' | 'binary' | 'uv' | 'command' | string
  entry_point?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  mcp_config?: Record<string, unknown>
}

export type McpbManifest = {
  dxt_version?: string
  name: string
  version: string
  description?: string
  author: McpbAuthor
  server?: McpbServer
  user_config?: Record<string, McpbUserConfigurationOption>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalid(message: string): never {
  throw new Error(`Invalid manifest: ${message}`)
}

function parseOption(key: string, value: unknown): McpbUserConfigurationOption {
  if (!isRecord(value)) invalid(`${key} must be an object`)
  const type = value.type
  if (
    type !== 'string' &&
    type !== 'number' &&
    type !== 'boolean' &&
    type !== 'directory' &&
    type !== 'file'
  ) {
    invalid(`${key}.type must be string, number, boolean, directory, or file`)
  }
  if (typeof value.title !== 'string' || value.title.length === 0) {
    invalid(`${key}.title must be a non-empty string`)
  }
  if (typeof value.description !== 'string') {
    invalid(`${key}.description must be a string`)
  }
  if (value.required !== undefined && typeof value.required !== 'boolean') {
    invalid(`${key}.required must be a boolean`)
  }
  if (value.multiple !== undefined && typeof value.multiple !== 'boolean') {
    invalid(`${key}.multiple must be a boolean`)
  }
  if (value.sensitive !== undefined && typeof value.sensitive !== 'boolean') {
    invalid(`${key}.sensitive must be a boolean`)
  }
  if (value.min !== undefined && typeof value.min !== 'number') {
    invalid(`${key}.min must be a number`)
  }
  if (value.max !== undefined && typeof value.max !== 'number') {
    invalid(`${key}.max must be a number`)
  }
  return value as McpbUserConfigurationOption
}

/** Validate and narrow a parsed manifest without a schema dependency. */
export function validateMcpbManifest(value: unknown): McpbManifest {
  if (!isRecord(value)) invalid('root must be an object')
  if (typeof value.name !== 'string' || value.name.length === 0) {
    invalid('name must be a non-empty string')
  }
  if (typeof value.version !== 'string' || value.version.length === 0) {
    invalid('version must be a non-empty string')
  }
  if (!isRecord(value.author) || typeof value.author.name !== 'string') {
    invalid('author.name must be a string')
  }
  if (value.server !== undefined) {
    if (!isRecord(value.server)) invalid('server must be an object')
    if (value.server.args !== undefined) {
      if (
        !Array.isArray(value.server.args) ||
        !value.server.args.every(item => typeof item === 'string')
      ) {
        invalid('server.args must be an array of strings')
      }
    }
    if (value.server.env !== undefined) {
      if (
        !isRecord(value.server.env) ||
        !Object.values(value.server.env).every(item => typeof item === 'string')
      ) {
        invalid('server.env must be a string map')
      }
    }
  }
  if (value.user_config !== undefined) {
    if (!isRecord(value.user_config)) invalid('user_config must be an object')
    for (const [key, option] of Object.entries(value.user_config)) {
      parseOption(key, option)
    }
  }
  return value as McpbManifest
}
