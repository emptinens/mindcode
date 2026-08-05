import { describe, expect, test } from 'bun:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = join(import.meta.dir, '../..')

const forbiddenRoutes = [
  '/api/claude_code/policy_limits',
  '/api/claude_code/user_settings',
  '/api/claude_code_penguin_mode',
  '/api/organization/claude_code_first_token_date',
  '/api/oauth/organizations/',
  '/api/oauth/usage',
  '/api/oauth/account/',
  '/api/claude_code_grove',
  '/v1/sessions/',
  '/v1/ultrareview/quota',
]

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectSourceFiles(path)
    if (!/\.(?:ts|tsx|js|jsx)$/.test(entry.name)) return []
    if (/\.test\.(?:ts|tsx)$/.test(entry.name)) return []
    return [path]
  })
}

describe('VEXZY endpoint boundary', () => {
  test('keeps removed account and legacy routes out of runtime source', () => {
    const matches: string[] = []
    for (const path of collectSourceFiles(sourceRoot)) {
      const source = readFileSync(path, 'utf8')
      for (const route of forbiddenRoutes) {
        if (source.includes(route)) matches.push(`${path}: ${route}`)
      }
    }
    expect(matches).toEqual([])
  })

  test('retains only the documented VEXZY endpoint constants', () => {
    const config = readFileSync(
      join(sourceRoot, 'services/api/vexzy/config.ts'),
      'utf8',
    )
    expect(config).toContain('/chat/completions')
    expect(config).toContain('/responses')
    expect(config).toContain('/models')
    expect(config).toContain('/v1/messages')
    expect(statSync(join(sourceRoot, 'services/api/vexzy')).isDirectory()).toBe(
      true,
    )
  })
})
