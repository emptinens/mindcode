import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

const agentSdkTypesMock = () => ({ HOOK_EVENTS: ['PreToolUse'] as const })
mock.module('src/entrypoints/agentSdkTypes.js', agentSdkTypesMock)
mock.module(
  new URL('../entrypoints/agentSdkTypes.ts', import.meta.url).pathname,
  agentSdkTypesMock,
)
mock.module('src/entrypoints/sdk/runtimeTypes.js', () => ({}))
mock.module(
  new URL('../entrypoints/sdk/runtimeTypes.ts', import.meta.url).pathname,
  () => ({}),
)

const {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} = await import('../services/api/vexzy/modelCatalog.js')
const { createVexzyModelClient } = await import(
  '../services/api/vexzy/modelClient.js'
)
const {
  convertEffortValueToLevel,
  getDisplayedEffortLevel,
  getCatalogEffortLevels,
  getSupportedEffortLevels,
  modelSupportsCatalogEffort,
  modelSupportsCatalogMaxEffort,
  modelSupportsCatalogXhighEffort,
  modelSupportsEffort,
  modelSupportsMaxEffort,
  modelSupportsXhighEffort,
  parseEffortValue,
  resolveAppliedEffort,
  toPersistableEffort,
} = await import('./effort.js')
const { isPersistableEffort } = await import('./effortCore.js')

const originalApiKey = process.env.VEXZY_API_KEY
const originalAlwaysEnable = process.env.MINDCODE_ALWAYS_ENABLE_EFFORT
const originalEffortLevel = process.env.MINDCODE_EFFORT_LEVEL

const model = (
  id: string,
  supportedReasoningEfforts: string[] = ['none'],
  available = true,
) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: id,
  available,
  ...(available ? {} : { status: 'maintenance' }),
  context_length: 1_000_000,
  supported_reasoning_efforts: supportedReasoningEfforts,
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: false },
})

const response = (...models: ReturnType<typeof model>[]) =>
  new Response(
    JSON.stringify({
      object: 'list',
      data: models,
    }),
    { status: 200 },
  )

async function withCatalog(
  models: ReturnType<typeof model>[],
  callback: () => void,
  load = true,
): Promise<void> {
  process.env.VEXZY_API_KEY = 'forge-effort-test-key'
  const catalog = configureVexzyModelCatalog(
    createVexzyModelClient({
      apiKey: 'forge-effort-test-key',
      fetch: async () => response(...models),
    }),
  )

  try {
    if (load) await catalog.load()
    callback()
  } finally {
    resetVexzyModelCatalog()
  }
}

beforeEach(() => {
  resetVexzyModelCatalog()
  Reflect.deleteProperty(process.env, 'MINDCODE_ALWAYS_ENABLE_EFFORT')
  Reflect.deleteProperty(process.env, 'MINDCODE_EFFORT_LEVEL')
})

afterEach(() => {
  resetVexzyModelCatalog()
  if (originalApiKey === undefined) {
    Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
  } else {
    process.env.VEXZY_API_KEY = originalApiKey
  }
  if (originalAlwaysEnable === undefined) {
    Reflect.deleteProperty(process.env, 'MINDCODE_ALWAYS_ENABLE_EFFORT')
  } else {
    process.env.MINDCODE_ALWAYS_ENABLE_EFFORT = originalAlwaysEnable
  }
  if (originalEffortLevel === undefined) {
    Reflect.deleteProperty(process.env, 'MINDCODE_EFFORT_LEVEL')
  } else {
    process.env.MINDCODE_EFFORT_LEVEL = originalEffortLevel
  }
})

describe('VEXZY catalog-backed effort capabilities', () => {
  test('uses exact model IDs and provider-advertised order', async () => {
    await withCatalog(
      [model('dynamic-leader', ['high', 'minimal', 'auto', 'max'])],
      () => {
        expect(getCatalogEffortLevels('dynamic-leader')).toEqual([
          'high',
          'minimal',
          'auto',
          'max',
        ])
        expect(getSupportedEffortLevels('dynamic-leader')).toEqual([
          'high',
          'minimal',
          'auto',
          'max',
        ])
        expect(getCatalogEffortLevels('DYNAMIC-LEADER')).toEqual([])
        expect(modelSupportsEffort('dynamic-leader')).toBe(true)
        expect(modelSupportsEffort('DYNAMIC-LEADER')).toBe(false)
      },
    )
  })

  test('supports every Leader provider value, including actual auto', async () => {
    await withCatalog(
      [model('leader-all', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'])],
      () => {
        for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] as const) {
          expect(resolveAppliedEffort('leader-all', level)).toBe(level)
          expect(toPersistableEffort(level)).toBe(level)
        }
        expect(isPersistableEffort('auto')).toBe(true)
      },
    )
  })

  test('defaults to medium, then auto, then the first advertised level', async () => {
    await withCatalog(
      [
        model('has-medium', ['low', 'high', 'medium', 'auto']),
        model('has-auto', ['high', 'auto']),
        model('first-only', ['minimal', 'high']),
      ],
      () => {
        expect(resolveAppliedEffort('has-medium', undefined)).toBe('medium')
        expect(resolveAppliedEffort('has-auto', undefined)).toBe('auto')
        expect(resolveAppliedEffort('first-only', undefined)).toBe('minimal')
      },
    )
  })

  test('keeps max on wire and distinguishes provider auto from clearing', async () => {
    await withCatalog(
      [model('leader-max', ['low', 'max', 'auto'])],
      () => {
        expect(resolveAppliedEffort('leader-max', 'max')).toBe('max')
        expect(getDisplayedEffortLevel('leader-max', 'max')).toBe('max')
        process.env.MINDCODE_EFFORT_LEVEL = 'auto'
        expect(resolveAppliedEffort('leader-max', undefined)).toBe('auto')
        process.env.MINDCODE_EFFORT_LEVEL = 'unset'
        expect(resolveAppliedEffort('leader-max', 'max')).toBeUndefined()
      },
    )
  })

  test('checks max and xhigh as exact catalog effort levels', async () => {
    await withCatalog(
      [
        model('max-model', ['none', 'max']),
        model('xhigh-model', ['none', 'xhigh']),
      ],
      () => {
        expect(modelSupportsCatalogMaxEffort('max-model')).toBe(true)
        expect(modelSupportsCatalogXhighEffort('max-model')).toBe(false)
        expect(modelSupportsMaxEffort('max-model')).toBe(true)
        expect(modelSupportsXhighEffort('max-model')).toBe(false)
        expect(modelSupportsMaxEffort('xhigh-model')).toBe(false)
        expect(modelSupportsXhighEffort('xhigh-model')).toBe(true)
      },
    )
  })

  test('fails closed for unavailable, unknown, and cold-catalog models', async () => {
    await withCatalog(
      [
        model('unavailable-model', ['low', 'max'], false),
        model('available-model', ['none']),
      ],
      () => {
        expect(getCatalogEffortLevels('unavailable-model')).toEqual([])
        expect(modelSupportsEffort('unavailable-model')).toBe(false)
        expect(modelSupportsMaxEffort('unavailable-model')).toBe(false)
        expect(modelSupportsEffort('unknown-model')).toBe(false)
        expect(resolveAppliedEffort('unavailable-model', 'none')).toBeUndefined()
        expect(resolveAppliedEffort('unknown-model', 'none')).toBeUndefined()
      },
    )

    await withCatalog(
      [model('cold-model', ['low', 'max'])],
      () => {
        expect(getCatalogEffortLevels('cold-model')).toEqual([])
        expect(modelSupportsCatalogEffort('cold-model')).toBe(false)
        expect(modelSupportsEffort('cold-model')).toBe(false)
        expect(modelSupportsMaxEffort('cold-model')).toBe(false)
        expect(resolveAppliedEffort('cold-model', 'none')).toBeUndefined()
      },
      false,
    )
  })

  test('MINDCODE_ALWAYS_ENABLE_EFFORT cannot bypass VEXZY catalog validation', async () => {
    await withCatalog([model('catalog-model', ['none'])], () => {
      process.env.MINDCODE_ALWAYS_ENABLE_EFFORT = '1'

      expect(modelSupportsEffort('catalog-model')).toBe(true)
      expect(modelSupportsEffort('unknown-model')).toBe(false)
      expect(modelSupportsMaxEffort('catalog-model')).toBe(false)
      expect(modelSupportsXhighEffort('catalog-model')).toBe(false)
    })
  })

  test('resolves none only when the exact catalog model advertises it', async () => {
    await withCatalog(
      [
        model('supports-none', ['none', 'medium']),
        model('no-none', ['low', 'medium', 'high']),
      ],
      () => {
        expect(resolveAppliedEffort('supports-none', 'none')).toBe('none')
        expect(resolveAppliedEffort('no-none', 'none')).toBeUndefined()
        expect(resolveAppliedEffort('SUPPORTS-NONE', 'none')).toBeUndefined()
        expect(resolveAppliedEffort('supports-none', 'high')).toBeUndefined()
        expect(resolveAppliedEffort('no-none', 'high')).toBe('high')
      },
    )
  })
})

test('parses, displays, and persists none without coercing it to high', () => {
  expect(parseEffortValue('none')).toBe('none')
  expect(parseEffortValue('NONE')).toBe('none')
  expect(convertEffortValueToLevel('none')).toBe('none')
  expect(isPersistableEffort('none')).toBe(true)
  expect(toPersistableEffort('none')).toBe('none')
})

test('never exposes legacy effort capabilities without a ready VEXZY catalog', () => {
  Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
  Reflect.deleteProperty(process.env, 'MINDCODE_ALWAYS_ENABLE_EFFORT')

  expect(modelSupportsMaxEffort('claude-opus-4-7')).toBe(false)
  expect(modelSupportsXhighEffort('claude-opus-4-7')).toBe(false)
  expect(resolveAppliedEffort('claude-opus-4-7', 'none')).toBeUndefined()
  expect(isPersistableEffort('max')).toBe(true)
})
