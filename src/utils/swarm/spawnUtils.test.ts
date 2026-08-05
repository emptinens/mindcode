import { describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { buildInheritedEnvVars, isTeammateEnvVarForwarded } = await import(
  './spawnUtils.js'
)
const { JAILBREAK_LEVEL_ENV_VAR } = await import('../jailbreak.js')

describe('Vexzy worker environment wiring', () => {
  test('includes VEXZY_API_KEY in tmux worker forwarding', () => {
    expect(isTeammateEnvVarForwarded('VEXZY_API_KEY')).toBe(true)
  })

  test('forwards MINDCODE_MODEL and not the legacy model variable', () => {
    const previousModel = process.env.MINDCODE_MODEL
    const previousLegacyModel = process.env.ANTHROPIC_MODEL

    try {
      process.env.MINDCODE_MODEL = 'sonnet'
      process.env.ANTHROPIC_MODEL = 'opus'

      expect(isTeammateEnvVarForwarded('MINDCODE_MODEL')).toBe(true)
      expect(isTeammateEnvVarForwarded('ANTHROPIC_MODEL')).toBe(false)
      expect(buildInheritedEnvVars()).toContain('MINDCODE_MODEL=gpt-5.6-luna')
      expect(buildInheritedEnvVars()).not.toContain('ANTHROPIC_MODEL=')
    } finally {
      if (previousModel === undefined) delete process.env.MINDCODE_MODEL
      else process.env.MINDCODE_MODEL = previousModel
      if (previousLegacyModel === undefined)
        delete process.env.ANTHROPIC_MODEL
      else process.env.ANTHROPIC_MODEL = previousLegacyModel
    }
  })

  test('forwards the leader-selected jailbreak level to pane workers', () => {
    const env = buildInheritedEnvVars('full')

    expect(isTeammateEnvVarForwarded(JAILBREAK_LEVEL_ENV_VAR)).toBe(true)
    expect(env).toContain(`${JAILBREAK_LEVEL_ENV_VAR}=full`)
  })

  test('does not put an unvalidated environment value in the spawn command', () => {
    const secret = 'forge-secret; touch /tmp/leaked'
    process.env[JAILBREAK_LEVEL_ENV_VAR] = secret

    const env = buildInheritedEnvVars()

    expect(env).not.toContain(secret)
    expect(env).toMatch(
      new RegExp(`${JAILBREAK_LEVEL_ENV_VAR}=(disabled|lowered|full)`),
    )
  })
})
