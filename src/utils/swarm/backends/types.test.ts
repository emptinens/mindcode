import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  configureVexzyModelCatalog,
  resetVexzyModelCatalog,
} from '../../../services/api/vexzy/modelCatalog.js'
import { createVexzyModelRegistry } from '../../../services/api/vexzy/modelRegistry.js'
import { getSwarmWorkerWeight } from '../concurrencyPolicy.js'
import {
  resolveWorkerEffort,
  resolveWorkerRuntime,
  WORKER_EFFORT_LEVELS,
} from './types.js'

const workerRegistry = createVexzyModelRegistry({
  object: 'list',
  data: [
    {
      id: 'gpt-5.6-luna',
      object: 'model',
      owned_by: 'vexzy',
      display_name: 'GPT-5.6 Luna',
      available: true,
      context_length: 1_100_000,
      supported_reasoning_efforts: [
        'none',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ],
      input_modalities: ['text'],
      output_modalities: ['text'],
      capabilities: { reasoning: true, tools: true, vision: false },
    },
  ],
})

beforeEach(async () => {
  const catalog = configureVexzyModelCatalog({
    getModels: async () => workerRegistry,
    refresh: async () => workerRegistry,
    getSnapshot: () => undefined,
  })
  await catalog.load()
})

afterEach(() => {
  resetVexzyModelCatalog()
})

describe('worker effort resolution', () => {
  test('includes every fixed Luna effort level', () => {
    expect(WORKER_EFFORT_LEVELS).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
  })

  test('defaults missing or invalid values to medium', () => {
    expect(resolveWorkerEffort(undefined)).toBe('medium')
    expect(resolveWorkerEffort(null)).toBe('medium')
    expect(resolveWorkerEffort(95)).toBe('medium')
    expect(resolveWorkerEffort('leader-effort')).toBe('medium')
  })

  test('preserves explicit worker effort', () => {
    for (const effort of WORKER_EFFORT_LEVELS) {
      expect(resolveWorkerEffort(effort)).toBe(effort)
    }
  })

  test('pins every worker runtime to Luna without inheriting Leader effort', () => {
    expect(resolveWorkerRuntime(undefined)).toEqual({
      model: 'gpt-5.6-luna',
      effort: 'medium',
    })
    for (const effort of WORKER_EFFORT_LEVELS) {
      expect(resolveWorkerRuntime(effort)).toEqual({
        model: 'gpt-5.6-luna',
        effort,
      })
    }
  })

  test('resolved effort maps to the weighted scheduler lease cost', () => {
    expect(getSwarmWorkerWeight(resolveWorkerEffort(undefined))).toBe(2)
    expect(getSwarmWorkerWeight(resolveWorkerEffort('max'))).toBe(8)
    expect(getSwarmWorkerWeight(resolveWorkerEffort('none'))).toBe(1)
  })
})
