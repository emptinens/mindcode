import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { isTeammateEnvVarForwarded } = await import('./spawnUtils.js')

describe('Vexzy worker environment wiring', () => {
  test('includes VEXZY_API_KEY in tmux worker forwarding', () => {
    expect(isTeammateEnvVarForwarded('VEXZY_API_KEY')).toBe(true)
  })
})
