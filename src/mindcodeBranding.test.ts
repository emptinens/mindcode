import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir)

const userFacingSources = [
  'tools/WebFetchTool/WebFetchTool.ts',
  'tools/WebSearchTool/WebSearchTool.ts',
  'tools/WebSearchTool/prompt.ts',
  'tools/AskUserQuestionTool/AskUserQuestionTool.tsx',
  'tools/EnterPlanModeTool/UI.tsx',
  'tools/ExitPlanModeTool/UI.tsx',
  'utils/permissions/permissions.ts',
  'commands/ide/ide.tsx',
  'commands/memory/memory.tsx',
  'components/MCPServerDialogCopy.tsx',
  'components/mcp/McpParsingWarnings.tsx',
  'components/mcp/MCPSettings.tsx',
  'utils/statusNoticeDefinitions.tsx',
  'utils/settings/validationTips.ts',
  'services/api/errors.ts',
  'tools/AgentTool/built-in/statuslineSetup.ts',
  'utils/attribution.ts',
  'services/voiceStreamSTT.ts',
]

function source(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
    .split('\n//# sourceMappingURL=', 1)[0]
}

function withoutAllowedTechnicalTokens(text: string): string {
  return text
    // VEXZY's dynamic catalog may expose legacy-compatible model IDs.
    .replace(/\bclaude-[a-z0-9-]+\b/gi, '')
    // These are wire-level compatibility headers, not user-visible branding.
    .replace(/\banthropic-(?:ratelimit|beta)[a-z0-9-]*\b/gi, '')
}

test('MindCode sources contain no legacy user-visible branding or docs URLs', () => {
  const combined = userFacingSources.map(source).join('\n')
  const normalized = withoutAllowedTechnicalTokens(combined)

  expect(normalized).not.toMatch(/\bClaude\b/)
  expect(normalized).not.toMatch(/\bAnthropic\b/)
  expect(normalized).not.toMatch(/https?:\/\/[^\s"'<>)]*(?:claude|anthropic)\.[^\s"'<>)]*/i)
  expect(normalized).not.toMatch(/https?:\/\/[^\s"'<>)]*\/anthropics(?:[\s"'<>)]|$)/i)
})

test('VEXZY-compatible claude model IDs remain allowed catalog values', () => {
  const registry = readFileSync(
    resolve(root, 'services/api/vexzy/modelRegistry.ts'),
    'utf8',
  )
  expect(registry).toMatch(/['"]claude-[a-z0-9-]+['"]/i)
  expect(registry).toContain("claude-sonnet-5")
})
