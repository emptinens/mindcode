import { afterEach, describe, expect, mock, test } from 'bun:test'

mock.module('./config.js', () => ({
  getGlobalConfig: () => ({}),
}))
mock.module('./envUtils.js', () => ({
  isEnvTruthy: (value: string | undefined) =>
    value === '1' || value?.toLowerCase() === 'true',
}))
mock.module('./model/model.js', () => ({
  getCanonicalName: (model: string) => model.toLowerCase(),
}))
mock.module('./model/modelCapabilities.js', () => ({
  getModelCapability: () => undefined,
}))

type MockCatalogModel = {
  id: string
  contextLength: number
  outputLimit: number
  available: boolean
}

type MockCatalogState = {
  state: 'uninitialized' | 'loading' | 'ready' | 'error'
  registry?: { get: (id: string) => MockCatalogModel | undefined }
}

let catalogState: MockCatalogState = { state: 'uninitialized' }

mock.module('../services/api/vexzy/modelCatalog.js', () => ({
  getVexzyModelCatalogState: () => catalogState,
}))

const {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
} = await import('./context.js')

const originalDisable1m = process.env.MINDCODE_DISABLE_1M_CONTEXT
const originalUserType = process.env.USER_TYPE
const originalVexzyApiKey = process.env.VEXZY_API_KEY

afterEach(() => {
  if (originalDisable1m === undefined) {
    clearEnv('MINDCODE_DISABLE_1M_CONTEXT')
  } else {
    process.env.MINDCODE_DISABLE_1M_CONTEXT = originalDisable1m
  }
  if (originalUserType === undefined) {
    clearEnv('USER_TYPE')
  } else {
    process.env.USER_TYPE = originalUserType
  }
  if (originalVexzyApiKey === undefined) {
    clearEnv('VEXZY_API_KEY')
  } else {
    process.env.VEXZY_API_KEY = originalVexzyApiKey
  }
  catalogState = { state: 'uninitialized' }
})

function clearEnv(name: string): void {
  Reflect.deleteProperty(process.env, name)
}

function setReadyCatalog(...models: MockCatalogModel[]): void {
  const byId = new Map(models.map(model => [model.id, model]))
  catalogState = {
    state: 'ready',
    registry: { get: id => byId.get(id) },
  }
  process.env.VEXZY_API_KEY = 'forge-context-test-key'
}

function model(
  id: string,
  contextLength: number,
  outputLimit: number,
  available = true,
): MockCatalogModel {
  return { id, contextLength, outputLimit, available }
}

describe('context windows', () => {
  test('uses catalog context and output limits for Vexzy Luna', () => {
    clearEnv('MINDCODE_DISABLE_1M_CONTEXT')
    clearEnv('USER_TYPE')
    setReadyCatalog(model('gpt-5.6-luna', 1_050_000, 128_000))

    expect(getContextWindowForModel('gpt-5.6-luna')).toBe(1_050_000)
    expect(getModelMaxOutputTokens('gpt-5.6-luna')).toEqual({
      default: 128_000,
      upperLimit: 128_000,
    })
  })

  test('resolves Terra, Sol, and arbitrary future IDs by exact catalog ID', () => {
    setReadyCatalog(
      model('gpt-5.6-terra', 1_100_000, 64_000),
      model('gpt-5.6-sol', 1_200_000, 256_000),
      model('future-model-2030', 777_777, 9_999),
    )

    expect(getContextWindowForModel('gpt-5.6-terra')).toBe(1_100_000)
    expect(getModelMaxOutputTokens('gpt-5.6-terra')).toEqual({
      default: 64_000,
      upperLimit: 64_000,
    })
    expect(modelSupports1M('gpt-5.6-terra')).toBe(true)
    expect(getContextWindowForModel('gpt-5.6-sol')).toBe(1_200_000)
    expect(getModelMaxOutputTokens('gpt-5.6-sol')).toEqual({
      default: 256_000,
      upperLimit: 256_000,
    })
    expect(getContextWindowForModel('future-model-2030')).toBe(777_777)
    expect(getModelMaxOutputTokens('future-model-2030')).toEqual({
      default: 9_999,
      upperLimit: 9_999,
    })
    expect(() => getContextWindowForModel('FUTURE-MODEL-2030')).toThrow(
      'not in the dynamic catalog',
    )
  })

  test('rejects unavailable and unknown Vexzy models', () => {
    setReadyCatalog(model('maintenance-model', 1_000_000, 128_000, false))

    expect(() => getContextWindowForModel('maintenance-model')).toThrow(
      'is unavailable',
    )
    expect(() => getModelMaxOutputTokens('unknown-model')).toThrow(
      'not in the dynamic catalog',
    )
  })

  test('fails closed for cold and error catalogs', () => {
    process.env.VEXZY_API_KEY = 'forge-context-test-key'

    catalogState = { state: 'uninitialized' }
    expect(() => getContextWindowForModel('gpt-5.6-luna')).toThrow(
      'state: uninitialized',
    )

    catalogState = { state: 'error' }
    expect(() => getModelMaxOutputTokens('gpt-5.6-luna')).toThrow(
      'state: error',
    )
  })

  test('does not downgrade catalog-backed Luna when legacy Claude 1M is disabled', () => {
    process.env.MINDCODE_DISABLE_1M_CONTEXT = 'true'
    clearEnv('USER_TYPE')
    setReadyCatalog(model('gpt-5.6-luna', 1_050_000, 128_000))

    expect(getContextWindowForModel('gpt-5.6-luna')).toBe(1_050_000)
    expect(modelSupports1M('gpt-5.6-luna')).toBe(true)
    expect(getModelMaxOutputTokens('gpt-5.6-luna').upperLimit).toBe(128_000)
  })

  test('rejects legacy and custom suffix aliases without a VEXZY catalog', () => {
    process.env.MINDCODE_DISABLE_1M_CONTEXT = 'true'
    clearEnv('USER_TYPE')
    clearEnv('VEXZY_API_KEY')

    expect(() => getContextWindowForModel('custom-model[1m]')).toThrow(
      'catalog is not ready',
    )
    expect(() => getContextWindowForModel('claude-custom[1m]')).toThrow(
      'catalog is not ready',
    )
  })
})
