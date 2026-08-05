import { describe, expect, test } from 'bun:test'
import {
  fetchBootstrapData,
  preloadVexzyCatalog,
} from './bootstrap.js'
import { VexzyModelCatalog } from './vexzy/modelCatalog.js'
import { createVexzyModelClient } from './vexzy/modelClient.js'

const modelPayload = {
  object: 'list' as const,
  data: [
    {
      id: 'vexzy-test-model',
      object: 'model' as const,
      owned_by: 'vexzy' as const,
      display_name: 'Vexzy Test Model',
      available: true,
      context_length: 128_000,
      supported_reasoning_efforts: ['none'],
      input_modalities: ['text'],
      output_modalities: ['text'],
      capabilities: { reasoning: false, tools: true, vision: false },
    },
  ],
}

describe('Vexzy catalog bootstrap', () => {
  test('preloads successfully without exposing catalog contents', async () => {
    let calls = 0
    await fetchBootstrapData(async () => {
      calls += 1
      return modelPayload
    })
    expect(calls).toBe(1)
  })

  test('does not resolve until catalog loading completes', async () => {
    let release: (() => void) | undefined
    let settled = false
    const loading = fetchBootstrapData(
      () =>
        new Promise<void>(resolve => {
          release = resolve
        }),
    ).then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    release?.()
    await loading
    expect(settled).toBe(true)
  })

  test('does not throw when catalog loading fails', async () => {
    await expect(
      preloadVexzyCatalog(async () => {
        throw new Error('catalog unavailable')
      }),
    ).resolves.toBeUndefined()
  })

  test('supports concurrent preloads through catalog deduplication', async () => {
    let requests = 0
    let release: (() => void) | undefined
    const catalog = new VexzyModelCatalog(
      createVexzyModelClient({
        apiKey: 'forge-bootstrap-test-key',
        fetch: async () => {
          requests += 1
          await new Promise<void>(resolve => {
            release = resolve
          })
          return new Response(JSON.stringify(modelPayload), { status: 200 })
        },
      }),
    )
    const loadCatalog = () => catalog.load()

    const first = fetchBootstrapData(loadCatalog)
    const second = fetchBootstrapData(loadCatalog)
    expect(requests).toBe(1)
    release?.()

    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      undefined,
    ])
  })
})
