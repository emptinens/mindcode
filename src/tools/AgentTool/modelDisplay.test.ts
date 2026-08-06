import { afterEach, beforeEach, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)

const { configureVexzyModelCatalog, resetVexzyModelCatalog } = await import(
  '../../services/api/vexzy/modelCatalog.js'
)
const { createVexzyModelRegistry } = await import(
  '../../services/api/vexzy/modelRegistry.js'
)
const { getAgentModelDisplay, getAgentModelOptions } = await import(
  '../../utils/model/agent.js'
)

beforeEach(async () => {
  const registry = createVexzyModelRegistry({
    object: 'list',
    data: [{
      id: 'gpt-5.6-luna',
      object: 'model',
      owned_by: 'vexzy',
      display_name: 'GPT-5.6 Luna',
      available: true,
      context_length: 1_100_000,
      supported_reasoning_efforts: ['none', 'low', 'medium', 'high'],
      input_modalities: ['text'],
      output_modalities: ['text'],
      capabilities: { reasoning: true, tools: true, vision: false },
    }],
  })
  const catalog = configureVexzyModelCatalog({
    getModels: async () => registry,
    refresh: async () => registry,
    getSnapshot: () => undefined,
  })
  await catalog.load()
})

afterEach(() => resetVexzyModelCatalog())

test('Agent model display is fixed independently of legacy model input', () => {
  expect(getAgentModelDisplay(undefined)).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('sonnet')).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('opus')).toBe('GPT-5.6 Luna')
  expect(getAgentModelDisplay('haiku')).toBe('GPT-5.6 Luna')
})

test('agent configuration exposes only the configured validated Worker model', () => {
  expect(getAgentModelOptions()).toEqual([
    {
      value: 'gpt-5.6-luna',
      label: 'GPT-5.6 Luna',
      description: 'Fixed exact VEXZY model for every Worker/subagent',
    },
  ])
})

test('Agent input schema hides the legacy model selector', () => {
  const source = readFileSync(new URL('./AgentTool.tsx', import.meta.url), 'utf8')
  expect(source).toContain(')).omit({ model: true })')
  expect(source).toContain("model: z.enum(['sonnet', 'opus', 'haiku']).optional()")
})

test('renderToolUseTag ignores the legacy model input', () => {
  const source = readFileSync(new URL('./UI.tsx', import.meta.url), 'utf8')
  expect(source).toContain(
    'getAgentModelDisplay(_input.model)',
  )
  expect(source).not.toContain('parseUserSpecifiedModel(input.model)')
})
