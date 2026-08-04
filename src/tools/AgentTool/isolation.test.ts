import { describe, expect, test } from 'bun:test'
import {
  extractUserPromptText,
  hasExplicitWorktreeRequest,
  resolveAgentIsolation,
  validateAgentLocationOptions,
} from './isolation.js'

describe('Agent isolation policy', () => {
  test('extracts prompts from both persisted message shapes', () => {
    expect(extractUserPromptText('plain string prompt')).toBe(
      'plain string prompt',
    )
    expect(
      extractUserPromptText([
        { type: 'text', text: 'first' },
        { type: 'image' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond')
  })

  test('defaults to the current working directory', () => {
    expect(resolveAgentIsolation(undefined)).toBeUndefined()
  })

  test('ignores a model-authored worktree argument without human intent', () => {
    expect(resolveAgentIsolation('worktree')).toBeUndefined()
  })

  test('does not infer isolation from agent-definition metadata', () => {
    const agentDefinition = { isolation: 'worktree' as const }
    expect(resolveAgentIsolation(undefined)).toBeUndefined()
    expect(agentDefinition.isolation).toBe('worktree')
  })

  test('honors explicit English and Russian user requests', () => {
    expect(
      resolveAgentIsolation(
        'worktree',
        'Run the implementation agent in a git worktree.',
      ),
    ).toBe('worktree')
    expect(
      resolveAgentIsolation(
        'worktree',
        'Запусти агента в изолированном git-репозитории.',
      ),
    ).toBe('worktree')
    expect(
      resolveAgentIsolation('worktree', 'Запусти агента в репозитории.'),
    ).toBe('worktree')
  })

  test('does not treat quoted failures or repository status as consent', () => {
    expect(
      hasExplicitWorktreeRequest(
        'Agent failed: isolation: "worktree". Git repository has no commits yet.',
      ),
    ).toBe(false)
    expect(
      hasExplicitWorktreeRequest(
        'Агент пишет: Cannot create agent worktree; git-репозиторий теперь создан.',
      ),
    ).toBe(false)
  })

  test('negation always keeps the agent in the current directory', () => {
    expect(
      resolveAgentIsolation(
        'worktree',
        'Do not use a worktree; run the agent locally.',
      ),
    ).toBeUndefined()
    expect(
      resolveAgentIsolation(
        'worktree',
        'Не используй worktree, работай в текущей папке.',
      ),
    ).toBeUndefined()
  })

  test('nested model prompts cannot authorize worktree isolation', () => {
    expect(
      resolveAgentIsolation(
        'worktree',
        'Run the agent in a git worktree.',
        true,
      ),
    ).toBeUndefined()
  })

  test('remote isolation is unaffected', () => {
    expect(resolveAgentIsolation('remote')).toBe('remote')
  })

  test('rejects conflicting cwd and isolation parameters', () => {
    expect(() =>
      validateAgentLocationOptions('/tmp/worker', 'worktree'),
    ).toThrow('cwd and isolation are mutually exclusive')
    expect(() => validateAgentLocationOptions('/tmp/worker')).not.toThrow()
    expect(() => validateAgentLocationOptions(undefined, 'worktree')).not.toThrow()
  })
})
