import { describe, expect, test } from 'bun:test'
import { generateExtensionId, validateManifest } from './helpers.js'

describe('local bundled-extension manifest contract', () => {
  test('accepts a minimal server manifest and preserves user config', async () => {
    const manifest = await validateManifest({
      name: 'Example MCP',
      version: '1.0.0',
      author: { name: 'MindCode' },
      server: { type: 'node', entry_point: 'server.js' },
      user_config: {
        TOKEN: {
          type: 'string',
          title: 'Token',
          description: 'Access token',
          required: true,
          sensitive: true,
        },
      },
    })

    expect(manifest.server?.entry_point).toBe('server.js')
    expect(manifest.user_config?.TOKEN?.sensitive).toBe(true)
    expect(generateExtensionId(manifest)).toBe('mindcode.example-mcp')
  })

  test('rejects malformed manifests with actionable errors', async () => {
    await expect(validateManifest({ name: 'missing fields' })).rejects.toThrow(
      'version must be a non-empty string',
    )
    await expect(
      validateManifest({
        name: 'Example',
        version: '1.0.0',
        author: { name: 'MindCode' },
        user_config: { PORT: { type: 'invalid' } },
      }),
    ).rejects.toThrow('PORT.type')
  })
})
