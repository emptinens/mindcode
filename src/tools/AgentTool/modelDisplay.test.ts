import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  getAgentModelDisplay,
  getAgentModelOptions,
} from '../../utils/model/agent.js'

test('Agent model display is fixed independently of legacy model input', () => {
  expect(getAgentModelDisplay(undefined)).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('sonnet')).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('opus')).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('haiku')).toBe('GPT-5.6 Luna')
})

test('agent configuration exposes only the fixed Luna model', () => {
  expect(getAgentModelOptions()).toEqual([
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fixed model for every agent and teammate',
    },
  ])
})

test('renderToolUseTag ignores the legacy model input', () => {
  const source = readFileSync(new URL('./UI.tsx', import.meta.url), 'utf8')
  expect(source).toContain(
    'getAgentModelDisplay(_input.model)',
  )
  expect(source).not.toContain('parseUserSpecifiedModel(input.model)')
})
