import { expect, test } from 'bun:test'
import {
  AdaptiveSwarmConcurrencyPolicy,
  AGENT_COST_BUDGET_ENV,
  DEFAULT_WORKER_COST_BUDGET,
  DEPRECATED_WORKER_COST_BUDGET_ENV,
  getSwarmWorkerWeight,
  MAX_FIT_BYPASSES,
  resetBudgetEnvironmentWarningForTests,
} from './concurrencyPolicy.js'

test('maps all six VEXZY worker effort values to fixed cost weights', () => {
  expect(getSwarmWorkerWeight('none')).toBe(1)
  expect(getSwarmWorkerWeight('low')).toBe(1)
  expect(getSwarmWorkerWeight('medium')).toBe(2)
  expect(getSwarmWorkerWeight('high')).toBe(4)
  expect(getSwarmWorkerWeight('xhigh')).toBe(6)
  expect(getSwarmWorkerWeight('max')).toBe(8)
  expect(getSwarmWorkerWeight(undefined)).toBe(2)
})

test('reads canonical budget env and warns once for the deprecated alias', () => {
  resetBudgetEnvironmentWarningForTests()
  const warnings: string[] = []

  expect(
    new AdaptiveSwarmConcurrencyPolicy({
      env: { [AGENT_COST_BUDGET_ENV]: '11' },
      onWarning: message => warnings.push(message),
    }).snapshot().configuredBudget,
  ).toBe(11)
  expect(warnings).toEqual([])

  const aliasOptions = {
    env: { [DEPRECATED_WORKER_COST_BUDGET_ENV]: '9' },
    onWarning: (message: string) => warnings.push(message),
  }
  expect(new AdaptiveSwarmConcurrencyPolicy(aliasOptions).snapshot().budget).toBe(
    9,
  )
  expect(new AdaptiveSwarmConcurrencyPolicy(aliasOptions).snapshot().budget).toBe(
    9,
  )
  expect(warnings).toHaveLength(1)
  expect(warnings[0]).toContain(DEPRECATED_WORKER_COST_BUDGET_ENV)

  expect(
    new AdaptiveSwarmConcurrencyPolicy({
      env: {
        [AGENT_COST_BUDGET_ENV]: '13',
        [DEPRECATED_WORKER_COST_BUDGET_ENV]: '4',
      },
      onWarning: message => warnings.push(message),
    }).snapshot().budget,
  ).toBe(13)
  expect(warnings).toHaveLength(1)
})

test('uses default budget and supports explicit constructor configuration', () => {
  expect(
    new AdaptiveSwarmConcurrencyPolicy({ env: {} }).snapshot().budget,
  ).toBe(DEFAULT_WORKER_COST_BUDGET)
  expect(
    new AdaptiveSwarmConcurrencyPolicy({ costBudget: 7 }).snapshot().budget,
  ).toBe(7)
  expect(new AdaptiveSwarmConcurrencyPolicy({ budget: 6 }).snapshot().budget).toBe(
    6,
  )
  expect(new AdaptiveSwarmConcurrencyPolicy(5).snapshot().budget).toBe(5)
})

test('computes effective budget from known limits and treats unknown limits as configured', () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy({
    configuredBudget: 32,
    budgetComponents: {
      cpu: 12,
      memory: undefined,
      rate: 20,
      token: null,
      health: 18,
    },
  })

  expect(policy.snapshot()).toMatchObject({
    configuredBudget: 32,
    effectiveBudget: 12,
    budget: 12,
    budgetComponents: {
      cpu: 12,
      memory: undefined,
      rate: 20,
      token: undefined,
      health: 18,
    },
  })
})

test('downscales immediately and requires two stable windows to upscale', () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy({ configuredBudget: 32 })

  policy.setBudgetComponents({
    cpu: 0,
    memory: 32,
    rate: 32,
    token: 32,
    health: 32,
  })
  expect(policy.getEffectiveBudget()).toBe(0)
  expect(policy.snapshot().pendingUpscaleBudget).toBeUndefined()

  const healthy = {
    cpu: 32,
    memory: 32,
    rate: 32,
    token: 32,
    health: 32,
  }
  expect(policy.setBudgetComponents(healthy)).toBe(0)
  expect(policy.snapshot()).toMatchObject({
    pendingUpscaleBudget: 32,
    stableUpscaleWindows: 1,
  })
  expect(policy.setBudgetComponents(healthy)).toBe(32)
  expect(policy.snapshot()).toMatchObject({
    effectiveBudget: 32,
    pendingUpscaleBudget: undefined,
    stableUpscaleWindows: 0,
  })

  policy.updateBudgetComponents({ rate: 4 })
  expect(policy.getEffectiveBudget()).toBe(4)
  policy.updateBudgetComponents({ rate: 32 })
  expect(policy.getEffectiveBudget()).toBe(4)
  policy.updateBudgetComponents({ rate: 32 })
  expect(policy.getEffectiveBudget()).toBe(32)
})

test('allows effective budget zero and rejects all new positive leases', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy({
    configuredBudget: 8,
    budgetComponents: { health: 0 },
  })

  await expect(policy.acquire('zero-budget', 'none')).rejects.toThrow(
    'effective cost budget 0',
  )
  expect(policy.snapshot().effectiveBudget).toBe(0)
})

test('enforces effective budget and reports active and queued weights', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(8)
  const first = await policy.acquire('team-a', 'high')
  const second = await policy.acquire('team-b', { effort: 'low', weight: 4 })
  const waiting = policy.acquire('team-c', 'medium')

  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 2,
    queuedRequests: 1,
    activeWeight: 8,
    queuedWeight: 2,
    budget: 8,
  })

  first.release()
  const third = await waiting
  expect(third.weight).toBe(2)
  expect(policy.snapshot().activeWeight).toBeLessThanOrEqual(8)

  second.release()
  third.release()
  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 0,
    queuedRequests: 0,
    activeWeight: 0,
    queuedWeight: 0,
    budget: 8,
  })
})

test('uses bounded fit-bypass while preserving FIFO and preventing starvation', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy({
    configuredBudget: 8,
    agingWindowMs: 1_000,
    now: () => 0,
  })
  const activeHigh = await policy.acquire('active-high', 'high')
  const activeMedium = await policy.acquire('active-medium', 'medium')
  const head = policy.acquire('head-max', 'max')
  const bypassOne = policy.acquire('bypass-one', 'low')
  const bypassTwo = policy.acquire('bypass-two', 'low')
  const afterBound = policy.acquire('after-bound', 'low')

  activeMedium.release()
  const first = await bypassOne
  const second = await bypassTwo
  expect(first.teamName).toBe('bypass-one')
  expect(second.teamName).toBe('bypass-two')
  expect(policy.snapshot()).toMatchObject({
    blockedHeadBypasses: MAX_FIT_BYPASSES,
    activeWeight: 6,
    queuedRequests: 2,
  })

  let headResolved = false
  void head.then(() => {
    headResolved = true
  })
  let afterBoundResolved = false
  void afterBound.then(() => {
    afterBoundResolved = true
  })
  await Promise.resolve()
  expect(headResolved).toBe(false)
  expect(afterBoundResolved).toBe(false)

  // Releasing the bounded bypass leases and then the remaining active lease
  // lets the FIFO head run before the request denied a third bypass.
  first.release()
  second.release()
  activeHigh.release()
  const headLease = await head
  expect(headLease.teamName).toBe('head-max')
  headLease.release()
  const finalLease = await afterBound
  expect(finalLease.teamName).toBe('after-bound')
  finalLease.release()
})

test('aging closes the bypass window before the numeric bound', async () => {
  let time = 0
  const policy = new AdaptiveSwarmConcurrencyPolicy({
    configuredBudget: 8,
    agingWindowMs: 10,
    now: () => time,
  })
  const activeHigh = await policy.acquire('active-high', 'high')
  const activeMedium = await policy.acquire('active-medium', 'medium')
  const head = policy.acquire('aged-head', 'max')
  time = 10
  const later = policy.acquire('later-low', 'low')
  activeMedium.release()
  let laterResolved = false
  void later.then(() => {
    laterResolved = true
  })
  await Promise.resolve()
  expect(laterResolved).toBe(false)
  expect(policy.snapshot().blockedHeadBypasses).toBe(0)

  activeHigh.release()
  const headLease = await head
  expect(headLease.teamName).toBe('aged-head')
  headLease.release()
  const laterLease = await later
  laterLease.release()
})

test('aborting a queued lease removes its weight and preserves FIFO', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(2)
  const active = await policy.acquire('active', 'medium')
  const controller = new AbortController()
  const aborted = policy.acquire('aborted', {
    effort: 'low',
    signal: controller.signal,
  })
  const waiting = policy.acquire('waiting', 'low')

  expect(policy.snapshot().queuedWeight).toBe(2)
  controller.abort()
  await expect(aborted).rejects.toThrow('aborted')
  expect(policy.snapshot()).toMatchObject({
    queuedRequests: 1,
    queuedWeight: 1,
  })

  active.release()
  const next = await waiting
  expect(next.teamName).toBe('waiting')
  next.release()
})

test('reset rejects queued requests and makes active lease release idempotent', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(1)
  const active = await policy.acquire('active', 'low')
  const waiting = policy.acquire('waiting', 'low')

  policy.reset()
  await expect(waiting).rejects.toThrow('reset')
  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 0,
    queuedRequests: 0,
    activeWeight: 0,
    queuedWeight: 0,
  })
  expect(active.release()).toBe(false)
  expect(active.release()).toBe(false)
})

test('concurrent acquire and release never exceed the effective budget', async () => {
  const budget = 32
  const policy = new AdaptiveSwarmConcurrencyPolicy(budget)
  const observed: number[] = []
  const settledLeases: Array<{
    lease: Awaited<ReturnType<typeof policy.acquire>>
    released: boolean
  }> = []
  const requests = Array.from({ length: 160 }, (_, index) =>
    policy
      .acquire(
        `team-${index}`,
        index % 4 === 0 ? 'max' : index % 3 === 0 ? 'high' : 'low',
      )
      .then(lease => {
        settledLeases.push({ lease, released: false })
        observed.push(policy.snapshot().activeWeight)
        return lease
      }),
  )

  while (policy.snapshot().demand > 0) {
    observed.push(policy.snapshot().activeWeight)
    for (const entry of settledLeases) {
      if (!entry.released) {
        entry.released = true
        expect(entry.lease.release()).toBe(true)
        observed.push(policy.snapshot().activeWeight)
      }
    }
    await Promise.resolve()
  }

  await Promise.all(requests)
  expect(observed.length).toBeGreaterThan(0)
  expect(Math.max(...observed)).toBeLessThanOrEqual(budget)
  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 0,
    queuedRequests: 0,
    activeWeight: 0,
    queuedWeight: 0,
  })
})
