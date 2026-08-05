import { describe, expect, test } from 'bun:test'
import {
  evaluateMindCodeMcpPolicy,
  evaluateMindCodePluginPolicy,
  getMindCodePluginPolicyDiagnostic,
  normalizeMindCodePolicyName,
  resolveMindCodeAllowedAlias,
} from './mindcodePluginPolicy.js'
import { isPluginBlockedByPolicy } from './pluginPolicy.js'

describe('MindCode plugin/MCP allowlist', () => {
  test('normalizes aliases without changing persisted identifiers', () => {
    expect(normalizeMindCodePolicyName(' Math_MCP ')).toBe('math-mcp')
    expect(resolveMindCodeAllowedAlias('ida@builtin')).toBe('ida')
    expect(resolveMindCodeAllowedAlias('ida-pro-mcp@mrexodia')).toBe('ida')
    expect(resolveMindCodeAllowedAlias('math')).toBe('math-mcp')
  })

  test('allows only IDA, Superpowers, and math-mcp families', () => {
    expect(evaluateMindCodePluginPolicy('ida@builtin').allowed).toBe(true)
    expect(evaluateMindCodePluginPolicy('ida-pro-mcp@mrexodia').allowed).toBe(
      true,
    )
    expect(evaluateMindCodePluginPolicy('superpowers@local').allowed).toBe(true)
    expect(evaluateMindCodePluginPolicy('math-mcp@builtin').allowed).toBe(true)
    expect(evaluateMindCodePluginPolicy('untrusted-plugin@marketplace').allowed).toBe(false)
  })

  test('accepts the factual IDA plugin id and exact aliases only', () => {
    for (const value of [
      'ida-pro-mcp@mrexodia',
      'ida-pro-mcp',
      'ida-mcp',
      'idamcp',
      'ida',
      'superpowers',
      'math-mcp',
      'math',
    ]) {
      expect(evaluateMindCodePluginPolicy(value).allowed).toBe(true)
    }

    for (const value of [
      'ida-pro-mcp@mrexodia-extra',
      'ida-pro-mcp-malicious',
      'superpowers-plus',
      'math-mcp-custom',
      'random-server@marketplace',
    ]) {
      expect(evaluateMindCodePluginPolicy(value).allowed).toBe(false)
    }
  })

  test('applies the same contract to standalone and plugin-provided MCP', () => {
    expect(evaluateMindCodeMcpPolicy('ida-pro-mcp@mrexodia').allowed).toBe(true)
    expect(evaluateMindCodeMcpPolicy('math').allowed).toBe(true)
    expect(evaluateMindCodeMcpPolicy('custom-server').allowed).toBe(false)
    expect(evaluateMindCodeMcpPolicy('arbitrary-server', 'superpowers@local').allowed).toBe(true)
    expect(evaluateMindCodeMcpPolicy('arbitrary-server', 'custom@marketplace').allowed).toBe(false)
  })

  test('exposes a non-secret diagnostic for visible integrations', () => {
    const diagnostic = getMindCodePluginPolicyDiagnostic()
    expect(diagnostic.mode).toBe('allowlist')
    expect(diagnostic.allowed).toEqual(['ida', 'superpowers', 'math-mcp'])
    expect(diagnostic.aliases.math).toBe('math-mcp')
    expect(diagnostic.aliases['ida-pro-mcp@mrexodia']).toBe('ida')
    expect(diagnostic.externalSettings).toBe('preserved')
  })
})



test('managed policy lookup imports the runtime policy module', () => {
  expect(typeof isPluginBlockedByPolicy).toBe('function')
})
