import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let sideQueryCalls = 0
let availableModels: string[] | undefined

mock.module(new URL('../../entrypoints/agentSdkTypes.ts', import.meta.url).pathname, () => ({
  HOOK_EVENTS: ['PreToolUse'] as const,
}))

mock.module(new URL('../sideQuery.ts', import.meta.url).pathname, () => ({
  sideQuery: async () => {
    sideQueryCalls += 1
    return {}
  },
}))

mock.module(new URL('./modelAllowlist.ts', import.meta.url).pathname, () => {
  const allowed = (model: string, explicit = availableModels) =>
    explicit === undefined || explicit.includes(model)
  return {
    isModelAllowed: allowed,
    isVexzyModelAllowed: allowed,
  }
})

const { validateModel, validateVexzyModel } = await import('./validateModel.js')
const { VexzyModelCatalog, configureVexzyModelCatalog, resetVexzyModelCatalog } =
  await import('../../services/api/vexzy/modelCatalog.js')
const { createVexzyModelClient } = await import(
  '../../services/api/vexzy/modelClient.js'
)

const model = (id: string, available = true) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: id,
  available,
  ...(available ? {} : { status: 'maintenance' }),
  context_length: 1_000_000,
  supported_reasoning_efforts: ['none'],
  input_modalities: ['text'],
  output_modalities: ['text'],
  capabilities: { reasoning: false, tools: true, vision: false },
})

const catalogPayload = (...models: ReturnType<typeof model>[]) => ({
  object: 'list' as const,
  data: models,
})

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

function createCatalog(
  payload: unknown,
  onFetch?: () => void,
) {
  return new VexzyModelCatalog(
    createVexzyModelClient({
      apiKey: 'forge-validation-test',
      fetch: async () => {
        onFetch?.()
        return response(payload)
      },
    }),
  )
}

beforeEach(() => {
  process.env.VEXZY_API_KEY = 'forge-validation-test'
  process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = undefined
  availableModels = undefined
  sideQueryCalls = 0
})

afterEach(() => {
  resetVexzyModelCatalog()
  Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')
  Reflect.deleteProperty(process.env, 'ANTHROPIC_CUSTOM_MODEL_OPTION')
  availableModels = undefined
})

describe('Vexzy model validation', () => {
  test('fails closed when the Vexzy credential is missing', async () => {
    Reflect.deleteProperty(process.env, 'VEXZY_API_KEY')

    await expect(validateModel('dynamic-id')).resolves.toEqual({
      valid: false,
      error: 'Vexzy authentication configuration is invalid',
    })
    expect(sideQueryCalls).toBe(0)
  })

  test('trims input, requires an exact available catalog ID, and never calls sideQuery', async () => {
    let fetchCalls = 0
    const client = createVexzyModelClient({
      apiKey: 'forge-validation-test',
      fetch: async () => {
        fetchCalls += 1
        return response(catalogPayload(model('dynamic-id')))
      },
    })
    configureVexzyModelCatalog(client)

    const result = await validateModel('  dynamic-id  ')

    expect(result).toEqual({ valid: true })
    expect(fetchCalls).toBe(1)
    expect(sideQueryCalls).toBe(0)
  })

  test('deduplicates a cold catalog load', async () => {
    let fetchCalls = 0
    let release: (() => void) | undefined
    const client = createVexzyModelClient({
      apiKey: 'forge-validation-test',
      fetch: async () => {
        fetchCalls += 1
        await new Promise<void>(resolve => {
          release = resolve
        })
        return response(catalogPayload(model('cold-id')))
      },
    })
    const catalog = new VexzyModelCatalog(client)

    const first = validateVexzyModel('cold-id', catalog)
    const second = validateVexzyModel('cold-id', catalog)
    expect(fetchCalls).toBe(1)
    release?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      { valid: true },
      { valid: true },
    ])
    expect(sideQueryCalls).toBe(0)
  })

  test('requires case-sensitive catalog IDs', async () => {
    const result = await validateVexzyModel(
      'DYNAMIC-ID',
      createCatalog(catalogPayload(model('dynamic-id'))),
    )

    expect(result).toEqual({
      valid: false,
      error: "Vexzy model 'DYNAMIC-ID' is not in the dynamic catalog",
    })
    expect(sideQueryCalls).toBe(0)
  })

  test('rejects unavailable catalog models', async () => {
    const result = await validateVexzyModel(
      'offline-id',
      createCatalog(catalogPayload(model('offline-id', false))),
    )

    expect(result).toEqual({
      valid: false,
      error: "Vexzy model 'offline-id' is unavailable",
    })
    expect(sideQueryCalls).toBe(0)
  })

  test('rejects unknown IDs, aliases, and custom model environment values', async () => {
    process.env.ANTHROPIC_CUSTOM_MODEL_OPTION = 'custom-id'
    const catalog = createCatalog(catalogPayload(model('dynamic-id')))

    await expect(validateVexzyModel('unknown-id', catalog)).resolves.toEqual({
      valid: false,
      error: "Vexzy model 'unknown-id' is not in the dynamic catalog",
    })
    await expect(validateVexzyModel('sonnet', catalog)).resolves.toEqual({
      valid: false,
      error: "Vexzy model 'sonnet' is not in the dynamic catalog",
    })
    await expect(validateVexzyModel('custom-id', catalog)).resolves.toEqual({
      valid: false,
      error: "Vexzy model 'custom-id' is not in the dynamic catalog",
    })
    expect(sideQueryCalls).toBe(0)
  })

  test('enforces availableModels before loading the catalog', async () => {
    availableModels = ['allowed-id']
    let fetchCalls = 0
    const catalog = createCatalog(catalogPayload(model('blocked-id')), () => {
      fetchCalls += 1
    })

    const result = await validateVexzyModel('blocked-id', catalog)

    expect(result).toEqual({
      valid: false,
      error: "Vexzy model 'blocked-id' is not allowed by availableModels",
    })
    expect(fetchCalls).toBe(0)
    expect(sideQueryCalls).toBe(0)
  })

  test('fails closed without leaking catalog error details', async () => {
    const catalog = new VexzyModelCatalog({
      getModels: async () => {
        throw new Error('secret forge-api-key response body')
      },
      refresh: async () => {
        throw new Error('secret forge-api-key response body')
      },
      getSnapshot: () => undefined,
    })

    const result = await validateVexzyModel('dynamic-id', catalog)

    expect(result).toEqual({
      valid: false,
      error: 'Vexzy model catalog could not be loaded',
    })
    expect(result.error).not.toContain('forge-api-key')
    expect(result.error).not.toContain('response body')
    expect(sideQueryCalls).toBe(0)
  })
})
