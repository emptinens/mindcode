import type { McpbManifest } from './manifest.js'
import { validateMcpbManifest } from './manifest.js'
import { errorMessage } from '../errors.js'
import { jsonParse } from '../slowOperations.js'

/** Parses and validates a bundled MCP extension manifest locally. */
export async function validateManifest(
  manifestJson: unknown,
): Promise<McpbManifest> {
  return validateMcpbManifest(manifestJson)
}

/** Parses and validates a manifest from raw text. */
export async function parseAndValidateManifestFromText(
  manifestText: string,
): Promise<McpbManifest> {
  let manifestJson: unknown
  try {
    manifestJson = jsonParse(manifestText)
  } catch (error) {
    throw new Error(`Invalid JSON in manifest.json: ${errorMessage(error)}`)
  }
  return validateManifest(manifestJson)
}

/** Parses and validates a manifest from raw binary data. */
export async function parseAndValidateManifestFromBytes(
  manifestData: Uint8Array,
): Promise<McpbManifest> {
  return parseAndValidateManifestFromText(new TextDecoder().decode(manifestData))
}

/** Generates a stable extension ID from author and extension names. */
export function generateExtensionId(
  manifest: McpbManifest,
  prefix?: 'local.unpacked' | 'local.dxt',
): string {
  const sanitize = (str: string) =>
    str
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9-_.]/g, '')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')

  const id = `${sanitize(manifest.author.name)}.${sanitize(manifest.name)}`
  return prefix ? `${prefix}.${id}` : id
}
