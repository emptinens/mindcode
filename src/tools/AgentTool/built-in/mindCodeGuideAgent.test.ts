import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./mindCodeGuideAgent.ts', import.meta.url), 'utf8')
const LEGACY_BRANDING = /Claude|Anthropic|code\.claude|platform\.claude|llms\.txt|Claude SDK/i

describe('MindCode built-in guide agent', () => {
  test('uses only MindCode and the VEXZY endpoint contract', () => {
    expect(SOURCE).toContain('You are the MindCode guide agent')
    expect(SOURCE).toContain('https://api.echogate.one/v1')
    expect(SOURCE).toContain('https://api.echogate.one/v1/models')
    expect(SOURCE).toContain('VEXZY_API_KEY')
    expect(SOURCE).toContain('local documentation and the endpoint contract')
    expect(SOURCE).not.toMatch(LEGACY_BRANDING)
  })

  test('does not retain provider-specific auth or documentation branches', () => {
    expect(SOURCE).not.toContain('isUsing3PServices')
    expect(SOURCE).not.toContain('MINDCODE_DOCS_MAP_URL')
    expect(SOURCE).not.toContain('CDP_DOCS_MAP_URL')
    expect(SOURCE).not.toContain('MACRO.ISSUES_EXPLAINER')
  })
})
