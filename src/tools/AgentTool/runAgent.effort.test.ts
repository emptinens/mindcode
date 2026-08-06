import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createVexzySDKAdapter } from '../../services/api/vexzy/sdkAdapter.js'

const runAgentSource = readFileSync(
  new URL('./runAgent.ts', import.meta.url),
  'utf8',
)

const responseBody = {
  type: 'message',
  id: 'worker-effort-regression',
  role: 'assistant',
  model: 'gpt-5.6-luna',
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
}

async function captureWorkerRequest(
  effort: 'none' | 'low' | 'max',
) {
  let requestBody: Record<string, unknown> | undefined
  const adapter = createVexzySDKAdapter({
    apiKey: 'forge-worker-effort-regression',
    fetch: async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return new Response(JSON.stringify(responseBody), { status: 200 })
    },
  })

  const workerThinkingConfig =
    effort === 'none' ? { type: 'disabled' } : { type: 'adaptive' }
  await adapter.messages.create({
    model: 'gpt-5.6-luna',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'worker request' }],
    // This is the same boundary projection performed by runAgent's child
    // AppState. It must win over the Leader's selected effort.
    output_config: { effort },
    thinking: workerThinkingConfig,
  })


  return requestBody
}

describe('AgentTool Worker effort provider boundary', () => {
  test('wires Worker thinking config instead of inheriting the Leader config', () => {
    expect(runAgentSource).toContain(
      'thinkingConfig: getWorkerThinkingConfig(resolvedWorkerEffort)',
    )
    expect(runAgentSource).toContain(
      "return effort === 'none' ? { type: 'disabled' } : { type: 'adaptive' }",
    )
  })

  test('Leader=max and Worker=low sends low reasoning_effort', async () => {
    const body = await captureWorkerRequest('low')

    expect(body?.reasoning_effort).toBe('low')
    expect(body?.thinking).toEqual({ type: 'adaptive' })
  })

  test('Worker=none disables thinking and sends none reasoning_effort', async () => {
    const body = await captureWorkerRequest('none')

    expect(body?.reasoning_effort).toBe('none')
    expect(body?.thinking).toEqual({ type: 'disabled' })
  })

  test('Worker=max sends max reasoning_effort regardless of Leader config', async () => {
    const body = await captureWorkerRequest('max')

    expect(body?.reasoning_effort).toBe('max')
    expect(body?.thinking).toEqual({ type: 'adaptive' })
  })
})
