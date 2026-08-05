import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('./UI.tsx', import.meta.url), 'utf8')

test('renders lifecycle preflight messages from the UI-compatible payload', () => {
  expect(source).toContain("candidate.type === 'agent_preflight_progress'")
  expect(source).toContain('return data.message.trim() || PREFLIGHT_PHASE_TEXT[phase]')
  expect(source).toContain("'Validating task dependencies…'")
  expect(source).toContain("'Waiting for worker budget…'")
  expect(source).toContain("'Preparing isolated worktree…'")
  expect(source).toContain("'Starting worker…'")
  expect(source).toContain('for (let index = progressMessages.length - 1; index >= 0; index -= 1)')
  expect(source).toContain('if (data && hasProgressMessage(data))')
})

test('keeps legacy message-only progress payloads and empty fallback compatible', () => {
  expect(source).toContain("progressMessages.length === 0 ? INITIALIZING_TEXT : 'Preparing agent…'")
  expect(source).toContain("if (data.message.type === 'user')")
  expect(source).toContain("if (data.message.type === 'assistant')")
  expect(source).toContain("getAgentPreflightStatus(progressMessages)")
})

test('does not use Initializing as the non-empty progress fallback', () => {
  const nonEmptyFallback = source.match(/if \(displayedMessages\.length === 0[\s\S]*?return <MessageResponse height=\{1\}>[\s\S]*?<Text dimColor>\{([^}]+)\}<\/Text>/)
  expect(nonEmptyFallback?.[1]).toBe('getAgentPreflightStatus(progressMessages)')
})

test('finds transcript prompt after preflight-only events', () => {
  expect(source).toContain('const firstAgentProgress = progressMessages.find(message => hasProgressMessage(message.data))')
  expect(source).not.toContain('const firstData = progressMessages[0]?.data')
})
