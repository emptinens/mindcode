import { expect, test } from 'bun:test'
import {
  AdaptiveSwarmConcurrencyPolicy,
  MAX_SWARM_WORKERS,
  getAdaptiveWorkerTarget,
} from './concurrencyPolicy.js'

test('adaptive target follows demand without exceeding the hard cap', () => {
  expect(getAdaptiveWorkerTarget(0)).toBe(0)
  expect(getAdaptiveWorkerTarget(1)).toBe(1)
  expect(getAdaptiveWorkerTarget(7)).toBe(7)
  expect(getAdaptiveWorkerTarget(100)).toBe(MAX_SWARM_WORKERS)
})

test('policy grants demand lazily and queues only above the cap', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(2)
  const first = await policy.acquire('team-a')
  const second = await policy.acquire('team-a')
  let thirdResolved = false
  const thirdPromise = policy.acquire('team-b').then(lease => {
    thirdResolved = true
    return lease
  })

  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 2,
    queuedRequests: 1,
    demand: 3,
    targetWorkers: 2,
    maxWorkers: 2,
  })
  expect(thirdResolved).toBe(false)

  first.release()
  const third = await thirdPromise
  expect(thirdResolved).toBe(true)
  expect(policy.snapshot().activeWorkers).toBe(2)

  second.release()
  third.release()
  expect(policy.snapshot()).toMatchObject({
    activeWorkers: 0,
    queuedRequests: 0,
    demand: 0,
    targetWorkers: 0,
  })
})

test('default policy hard-caps concurrent workers at twenty', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy()
  const leases = await Promise.all(
    Array.from({ length: MAX_SWARM_WORKERS }, (_, index) =>
      policy.acquire(`team-${index}`),
    ),
  )
  let overflowResolved = false
  const overflow = policy.acquire('overflow').then(lease => {
    overflowResolved = true
    return lease
  })

  expect(policy.snapshot()).toMatchObject({
    activeWorkers: MAX_SWARM_WORKERS,
    queuedRequests: 1,
    targetWorkers: MAX_SWARM_WORKERS,
    maxWorkers: MAX_SWARM_WORKERS,
  })
  expect(overflowResolved).toBe(false)

  leases[0]?.release()
  const overflowLease = await overflow
  expect(overflowResolved).toBe(true)
  overflowLease.release()
  for (const lease of leases.slice(1)) lease.release()
})

test('abort removes a queued request and drains the next request', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(1)
  const active = await policy.acquire('team-a')
  const controller = new AbortController()
  const aborted = policy.acquire('team-b', controller.signal)
  const waiting = policy.acquire('team-c')

  controller.abort()
  await expect(aborted).rejects.toThrow('aborted')
  active.release()
  const next = await waiting
  expect(next.teamName).toBe('team-c')
  next.release()
})

test('lease release is idempotent', async () => {
  const policy = new AdaptiveSwarmConcurrencyPolicy(1)
  const lease = await policy.acquire('team-a')
  expect(lease.release()).toBeUndefined()
  expect(lease.release()).toBeUndefined()
  expect(policy.snapshot().activeWorkers).toBe(0)
})
