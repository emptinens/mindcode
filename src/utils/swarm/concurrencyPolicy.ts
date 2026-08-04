/**
 * Demand-driven concurrency control for swarm workers.
 *
 * The policy is intentionally a permit pool rather than a pre-spawn pool:
 * workers are created only when a caller requests one.  Concurrent demand can
 * consume up to MAX_SWARM_WORKERS permits, while excess requests wait FIFO for
 * a permit to be released.
 */

export const MAX_SWARM_WORKERS = 20

type Waiter = {
  teamName: string
  resolve: (lease: SwarmWorkerLease) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

export type SwarmConcurrencySnapshot = {
  activeWorkers: number
  queuedRequests: number
  demand: number
  targetWorkers: number
  maxWorkers: number
}

export type SwarmWorkerLease = {
  leaseId: string
  teamName: string
  release: () => void
}

/**
 * Computes the desired worker count from current demand.
 *
 * This is a target, not a spawn instruction.  Callers still create workers
 * one at a time; the target simply grows with outstanding demand and never
 * exceeds the hard cap.
 */
export function getAdaptiveWorkerTarget(
  demand: number,
  activeWorkers = 0,
): number {
  const normalizedDemand = Number.isFinite(demand)
    ? Math.max(0, Math.floor(demand))
    : 0
  const normalizedActive = Number.isFinite(activeWorkers)
    ? Math.max(0, Math.floor(activeWorkers))
    : 0

  return Math.min(
    MAX_SWARM_WORKERS,
    Math.max(normalizedActive, normalizedDemand),
  )
}

export class AdaptiveSwarmConcurrencyPolicy {
  private readonly leases = new Map<string, string>()
  private readonly waiters: Waiter[] = []
  private nextLeaseId = 0

  private readonly maxWorkers: number

  constructor(maxWorkers = MAX_SWARM_WORKERS) {
    if (!Number.isInteger(maxWorkers) || maxWorkers < 1) {
      throw new Error('maxWorkers must be a positive integer')
    }
    this.maxWorkers = Math.min(MAX_SWARM_WORKERS, maxWorkers)
  }

  acquire(teamName: string, signal?: AbortSignal): Promise<SwarmWorkerLease> {
    if (signal?.aborted) {
      return Promise.reject(new Error('Swarm worker acquisition aborted'))
    }

    return new Promise<SwarmWorkerLease>((resolve, reject) => {
      const waiter: Waiter = { teamName, resolve, reject, signal }

      if (signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index !== -1) {
            this.waiters.splice(index, 1)
          }
          reject(new Error('Swarm worker acquisition aborted'))
          this.drain()
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }

      this.waiters.push(waiter)
      this.drain()
    })
  }

  release(leaseId: string): boolean {
    const released = this.leases.delete(leaseId)
    if (released) {
      this.drain()
    }
    return released
  }

  snapshot(): SwarmConcurrencySnapshot {
    const demand = this.leases.size + this.waiters.length
    return {
      activeWorkers: this.leases.size,
      queuedRequests: this.waiters.length,
      demand,
      targetWorkers: Math.min(
        this.maxWorkers,
        getAdaptiveWorkerTarget(demand, this.leases.size),
      ),
      maxWorkers: this.maxWorkers,
    }
  }

  reset(): void {
    for (const waiter of this.waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }
      waiter.reject(new Error('Swarm concurrency policy reset'))
    }
    this.leases.clear()
  }

  private drain(): void {
    while (this.leases.size < this.maxWorkers && this.waiters.length > 0) {
      const waiter = this.waiters.shift()
      if (!waiter) break
      if (waiter.signal?.aborted) {
        waiter.reject(new Error('Swarm worker acquisition aborted'))
        continue
      }

      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort)
      }

      const leaseId = `swarm-worker-${++this.nextLeaseId}`
      this.leases.set(leaseId, waiter.teamName)
      let released = false
      const lease: SwarmWorkerLease = {
        leaseId,
        teamName: waiter.teamName,
        release: () => {
          if (released) return
          released = true
          this.release(leaseId)
        },
      }
      waiter.resolve(lease)
    }
  }
}

const defaultPolicy = new AdaptiveSwarmConcurrencyPolicy()

export function acquireSwarmWorkerSlot(
  teamName: string,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease> {
  return defaultPolicy.acquire(teamName, signal)
}

export function releaseSwarmWorkerSlot(leaseId: string): boolean {
  return defaultPolicy.release(leaseId)
}

export function getSwarmConcurrencySnapshot(): SwarmConcurrencySnapshot {
  return defaultPolicy.snapshot()
}

/** Test-only reset hook; no production caller should need this. */
export function resetSwarmConcurrencyPolicy(): void {
  defaultPolicy.reset()
}
