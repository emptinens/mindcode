import { describe, expect, test } from 'bun:test'
import {
  VexzyModelCatalog,
  configureVexzyModelCatalog,
  getVexzyModelById,
  getVexzyModelCapabilities,
  getVexzyModelCatalogOptions,
  isVexzyCatalogModelAvailable,
  requireVexzyModelCatalog,
  resetVexzyModelCatalog,
  toVexzyModelCatalogOption,
} from './modelCatalog.js'
import { createVexzyModelClient } from './modelClient.js'
import { createVexzyModelRegistry } from './modelRegistry.js'

const model = (id: string, available = true) => ({
  id,
  object: 'model' as const,
  owned_by: 'vexzy' as const,
  display_name: `Display ${id}`,
  available,
  ...(available ? {} : { status: 'maintenance' }),
  context_length: 1_050_000,
  supported_reasoning_efforts: ['none', 'low', 'max'],
  input_modalities: ['text', 'image'],
  output_modalities: ['text'],
  capabilities: { reasoning: true, tools: true, vision: true },
})

const payload = (...models: ReturnType<typeof model>[]) => ({
  object: 'list' as const,
  data: models,
})

const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status })

describe('Vexzy model catalog', () => {
  test('builds exact-ID leader options and preserves registry metadata', () => {
    const registry = createVexzyModelRegistry({
      object: 'list',
      data: [model('gpt-5.6-luna'), model('maintenance-model', false)],
    })

    const options = getVexzyModelCatalogOptions(registry)
    expect(options).toHaveLength(2)
    expect(options[0]).toMatchObject({
      value: 'gpt-5.6-luna',
      label: 'Display gpt-5.6-luna',
      displayName: 'Display gpt-5.6-luna',
      contextLength: 1_050_000,
      supportedReasoningEfforts: ['none', 'low', 'max'],
      available: true,
      disabled: false,
      unavailable: false,
    })
    expect(options[1]).toMatchObject({
      value: 'maintenance-model',
      disabled: true,
      unavailable: true,
      available: false,
    })
    const firstModel = registry.models[0]
    const firstOption = options[0]
    expect(firstModel).toBeDefined()
    expect(firstOption).toBeDefined()
    if (firstModel === undefined || firstOption === undefined) {
      throw new Error('Expected a model and catalog option')
    }
    expect(toVexzyModelCatalogOption(firstModel)).toEqual(firstOption)
  })

  test('deduplicates concurrent loads through the shared model client', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => {
        calls += 1
        await new Promise<void>(resolve => {
          release = resolve
        })
        return response(payload(model('dynamic-leader')))
      },
    })
    const catalog = new VexzyModelCatalog(client)

    const first = catalog.load()
    const second = catalog.load()
    expect(calls).toBe(1)
    release?.()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(catalog.getOptions()[0]?.value).toBe('dynamic-leader')
  })

  test('retains the last snapshot when refresh receives a transient failure', async () => {
    let calls = 0
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => {
        calls += 1
        return calls === 1
          ? response(payload(model('last-known-model')))
          : response('temporarily unavailable', 503)
      },
      sleep: async () => {},
    })
    const catalog = new VexzyModelCatalog(client)

    await catalog.load()
    const refreshed = await catalog.refresh()

    expect(refreshed.get('last-known-model')).toBeDefined()
    expect(catalog.getOptions()[0]?.value).toBe('last-known-model')
  })

  test('emits loading and ready transitions once and exposes explicit stale metadata', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => {
        calls += 1
        if (calls === 1) {
          await new Promise<void>(resolve => {
            release = resolve
          })
        }
        return response(payload(model('observable-model')))
      },
    })
    const catalog = new VexzyModelCatalog(client)
    const states: string[] = []
    const unsubscribe = catalog.subscribe(state => {
      states.push(state.state)
      if (state.state === 'loading') {
        expect(state.registry).toBeUndefined()
        expect(state.lastRegistry).toBeUndefined()
      }
    })

    const loading = catalog.load()
    expect(catalog.state).toBe('loading')
    release?.()
    await loading

    expect(states).toEqual(['loading', 'ready'])
    expect(catalog.registry?.get('observable-model')).toBeDefined()
    expect(catalog.lastRegistry?.get('observable-model')).toBeDefined()
    unsubscribe()
    await catalog.refresh()
    expect(states).toEqual(['loading', 'ready'])
  })

  test('enters error without treating the last registry as ready', async () => {
    let calls = 0
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => {
        calls += 1
        return calls === 1
          ? response(payload(model('stale-model')))
          : response('bad gateway', 502)
      },
      sleep: async () => {},
    })
    const catalog = new VexzyModelCatalog(client)
    const states: string[] = []
    catalog.subscribe(state => states.push(state.state))

    await catalog.load()
    await expect(catalog.refresh()).rejects.toBeDefined()

    expect(states).toEqual(['loading', 'ready', 'loading', 'error'])
    expect(catalog.state).toBe('error')
    expect(catalog.registry).toBeUndefined()
    expect(catalog.lastRegistry?.get('stale-model')).toBeDefined()
    expect(catalog.getOptions()).toEqual([])
  })

  test('requires ready state and performs exact model access', async () => {
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () =>
        response(
          payload(
            model('exact-model'),
            model('exact-model-suffix'),
            model('offline-model', false),
          ),
        ),
    })
    const catalog = configureVexzyModelCatalog(client)

    try {
      expect(() => requireVexzyModelCatalog()).toThrow(/not ready/)
      expect(getVexzyModelById('exact-model')).toBeUndefined()
      expect(isVexzyCatalogModelAvailable('exact-model')).toBe(false)
      expect(getVexzyModelCapabilities('exact-model')).toBeUndefined()
      await catalog.load()

      expect(getVexzyModelById('exact-model')?.id).toBe('exact-model')
      expect(getVexzyModelById('exact')).toBeUndefined()
      expect(isVexzyCatalogModelAvailable('exact-model')).toBe(true)
      expect(isVexzyCatalogModelAvailable('offline-model')).toBe(false)
      expect(isVexzyCatalogModelAvailable('missing-model')).toBe(false)
      expect(getVexzyModelCapabilities('exact-model')).toEqual({
        reasoning: true,
        tools: true,
        vision: true,
      })
      expect(requireVexzyModelCatalog().has('exact-model')).toBe(true)
    } finally {
      resetVexzyModelCatalog()
    }
  })

  test('deduplicates concurrent load and refresh transitions', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => {
        calls += 1
        await new Promise<void>(resolve => {
          release = resolve
        })
        return response(payload(model('concurrent-model')))
      },
    })
    const catalog = new VexzyModelCatalog(client)
    const states: string[] = []
    catalog.subscribe(state => states.push(state.state))

    const first = catalog.load()
    const second = catalog.refresh()
    expect(calls).toBe(1)
    expect(catalog.state).toBe('loading')
    release?.()

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(states).toEqual(['loading', 'ready'])
  })

  test('configure and reset clear prior state and listeners', async () => {
    const client = createVexzyModelClient({
      apiKey: 'forge-test-key',
      fetch: async () => response(payload(model('old-model'))),
    })
    const oldCatalog = configureVexzyModelCatalog(client)
    const states: string[] = []
    oldCatalog.subscribe(state => states.push(state.state))

    const newCatalog = configureVexzyModelCatalog(client)
    await oldCatalog.load()

    expect(states).toEqual([])
    expect(oldCatalog.state).toBe('ready')
    expect(newCatalog.state).toBe('uninitialized')

    resetVexzyModelCatalog()
    expect(newCatalog.state).toBe('uninitialized')
  })
})
