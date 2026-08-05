import { describe, expect, test } from 'bun:test'
import {
  _resetPolicyLimitsForTesting,
  clearPolicyLimitsCache,
  initializePolicyLimitsLoadingPromise,
  isPolicyAllowed,
  isPolicyLimitsEligible,
  loadPolicyLimits,
  refreshPolicyLimits,
  startBackgroundPolling,
  stopBackgroundPolling,
  waitForPolicyLimitsToLoad,
} from './index.js'

describe('local policy-limits compatibility boundary', () => {
  test('defaults every policy to allowed without eligibility', async () => {
    _resetPolicyLimitsForTesting()
    expect(isPolicyLimitsEligible()).toBe(false)
    expect(isPolicyAllowed('allow_product_feedback')).toBe(true)
    expect(isPolicyAllowed('unknown_policy')).toBe(true)

    initializePolicyLimitsLoadingPromise()
    await waitForPolicyLimitsToLoad()
    await loadPolicyLimits()
    await refreshPolicyLimits()
    await clearPolicyLimitsCache()
    startBackgroundPolling()
    stopBackgroundPolling()
  })

  test('does not expose a remote endpoint, cache, or HTTP client', async () => {
    const source = await Bun.file(
      new URL('./index.ts', import.meta.url),
    ).text()

    expect(source).not.toContain('axios')
    expect(source).not.toContain('getOauthConfig')
    expect(source).not.toContain('/api/')
    expect(source).not.toContain('setInterval')
    expect(source).not.toContain('writeFile')
  })
})
