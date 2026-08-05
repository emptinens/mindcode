import { describe, expect, test } from 'bun:test'
import { filterMindCodeMcpEntries } from '../../utils/plugins/mindcodePluginPolicy.js'

describe('MindCode MCP runtime policy', () => {
  test('skips blocked entries and preserves the input record', () => {
    const configs = {
      ida: { command: 'ida-mcp' },
      custom: { command: 'custom-mcp' },
      'plugin:superpowers:tools': {
        command: 'superpowers-mcp',
        pluginSource: 'superpowers@local',
      },
    }

    const result = filterMindCodeMcpEntries(configs)

    expect(Object.keys(result.allowed)).toEqual([
      'ida',
      'plugin:superpowers:tools',
    ])
    expect(result.blocked).toEqual([
      expect.objectContaining({ name: 'custom' }),
    ])
    expect(configs.custom.command).toBe('custom-mcp')
  })

  test('does not permit an unallowlisted plugin to smuggle an MCP server', () => {
    const result = filterMindCodeMcpEntries({
      'plugin:custom:server': {
        command: 'custom-mcp',
        pluginSource: 'custom@marketplace',
      },
    })

    expect(result.allowed).toEqual({})
    expect(result.blocked[0]?.reason).toContain('owning plugin')
  })
})
