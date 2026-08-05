import { expect, test } from 'bun:test'
import { settleWithFallback } from './settleWithFallback.js'

test('settleWithFallback preserves success and fails open', async () => {
  expect(await settleWithFallback(Promise.resolve('ok'), 'fallback', 50)).toBe(
    'ok',
  )
  expect(
    await settleWithFallback(Promise.reject(new Error('failed')), 'fallback', 50),
  ).toBe('fallback')
  expect(
    await settleWithFallback(new Promise<string>(() => {}), 'fallback', 5),
  ).toBe('fallback')
})
