import type { EffortValue } from '../effort.js'

export const DEFAULT_WORKER_COST_BUDGET = 32
export const AGENT_COST_BUDGET_ENV = 'MINDCODE_AGENT_COST_BUDGET'
export const DEPRECATED_WORKER_COST_BUDGET_ENV =
  'MINDCODE_WORKER_COST_BUDGET'

/** Cost units consumed by a worker lease. */
export const SWARM_EFFORT_WEIGHTS = Object.freeze({
  none: 1,
  low: 1,
  medium: 2,
  high: 4,
  xhigh: 6,
  max: 8,
}) satisfies Record<
  'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max',
  number
>

export const EFFORT_WEIGHTS = SWARM_EFFORT_WEIGHTS

export const SWARM_BUDGET_COMPONENTS = [
  'cpu',
  'memory',
  'rate',
  'token',
  'health',
] as const

export type SwarmBudgetComponentName =
  (typeof SWARM_BUDGET_COMPONENTS)[number]

/** A missing/null component is unknown and therefore does not reduce budget. */
export type SwarmBudgetComponents = Partial<
  Record<SwarmBudgetComponentName, number | null | undefined>
>

export type SwarmEffort = EffortValue | 'none'

export type SwarmWorkerAcquireOptions = {
  effort?: SwarmEffort
  weight?: number
  signal?: AbortSignal
}

type Waiter = {
  teamName: string
  effort: SwarmEffort
  weight: number
  queuedAt: number
  resolve: (lease: SwarmWorkerLease) => void
  reject: (error: Error) => void
  signal?: AbortSignal
  onAbort?: () => void
}

type ActiveLease = {
  teamName: string
  effort: SwarmEffort
  weight: number
}

export type SwarmWorkerLease = {
  leaseId: string
  teamName: string
  effort: SwarmEffort
  weight: number
  release: () => boolean
}

export type SwarmConcurrencySnapshot = {
  activeWorkers: number
  queuedRequests: number
  demand: number
  activeWeight: number
  queuedWeight: number
  /** Effective budget after all known resource limits. */
  budget: number
  configuredBudget: number
  effectiveBudget: number
  availableWeight: number
  budgetComponents: Readonly<
    Record<SwarmBudgetComponentName, number | undefined>
  >
  pendingUpscaleBudget: number | undefined
  stableUpscaleWindows: number
  blockedHeadBypasses: number
}

export type SwarmConcurrencyPolicyOptions = {
  /** Backward-compatible constructor names; all represent configured budget. */
  budget?: number
  costBudget?: number
  configuredBudget?: number
  /** Environment source used when no explicit configured budget is supplied. */
  env?: Record<string, string | undefined>
  /** Optional warning sink for the deprecated environment alias. */
  onWarning?: (message: string) => void

  /** Initial known resource ceilings. Unknown components use configuredBudget. */
  budgetComponents?: SwarmBudgetComponents
  components?: SwarmBudgetComponents
  limits?: SwarmBudgetComponents
  cpu?: number | null
  memory?: number | null
  rate?: number | null
  token?: number | null
  health?: number | null
  cpuBudget?: number | null
  memoryBudget?: number | null
  rateBudget?: number | null
  tokenBudget?: number | null
  healthBudget?: number | null

  /** Clock and age threshold are injectable for deterministic scheduler tests. */
  now?: () => number
  agingWindowMs?: number
}

export const MAX_FIT_BYPASSES = 2
export const DEFAULT_AGING_WINDOW_MS = 1_000

const ABORTED_MESSAGE = 'Swarm worker acquisition aborted'
const RESET_MESSAGE = 'Swarm concurrency policy reset'
let deprecatedBudgetWarningIssued = false

type WarningSink = (message: string) => void

function defaultWarningSink(message: string): void {
  console.warn(message)
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    'aborted' in value &&
    'addEventListener' in value &&
    'removeEventListener' in value
  )
}

function isValidBudget(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function validateBudget(value: number): number {
  if (!isValidBudget(value)) {
    throw new Error('worker cost budget must be a finite non-negative number')
  }
  return value
}

function parseEnvironmentBudget(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_WORKER_COST_BUDGET
  }

  const parsed = Number(raw)
  return isValidBudget(parsed) ? parsed : DEFAULT_WORKER_COST_BUDGET
}

/**
 * Read the canonical budget environment variable. The old worker alias is
 * read only when the canonical variable is absent and emits one process-wide
 * migration warning when it is used.
 */
export function getConfiguredSwarmWorkerBudget(
  env: Record<string, string | undefined> = process.env,
  warningSink: WarningSink = defaultWarningSink,
): number {
  const canonical = env[AGENT_COST_BUDGET_ENV]
  if (canonical !== undefined) return parseEnvironmentBudget(canonical)

  const deprecated = env[DEPRECATED_WORKER_COST_BUDGET_ENV]
  if (deprecated !== undefined) {
    if (!deprecatedBudgetWarningIssued) {
      deprecatedBudgetWarningIssued = true
      warningSink(
        `${DEPRECATED_WORKER_COST_BUDGET_ENV} is deprecated; use ${AGENT_COST_BUDGET_ENV}`,
      )
    }
    return parseEnvironmentBudget(deprecated)
  }

  return DEFAULT_WORKER_COST_BUDGET
}

/** Compatibility name for callers that used the old internal helper. */
export const readConfiguredBudget = getConfiguredSwarmWorkerBudget

/** Test-only reset for the process-wide deprecation warning latch. */
export function resetBudgetEnvironmentWarningForTests(): void {
  deprecatedBudgetWarningIssued = false
}

function validateWeight(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('worker lease weight must be a finite positive number')
  }
  return value
}

function normalizeComponent(
  value: number | null | undefined,
  name: SwarmBudgetComponentName,
): number | undefined {
  if (value === null || value === undefined) return undefined
  if (!isValidBudget(value)) {
    throw new Error(
      `worker budget component ${name} must be a finite non-negative number`,
    )
  }
  return value
}

function normalizeBudgetComponents(
  components: SwarmBudgetComponents | undefined,
): Readonly<Record<SwarmBudgetComponentName, number | undefined>> {
  return Object.freeze({
    cpu: normalizeComponent(components?.cpu, 'cpu'),
    memory: normalizeComponent(components?.memory, 'memory'),
    rate: normalizeComponent(components?.rate, 'rate'),
    token: normalizeComponent(components?.token, 'token'),
    health: normalizeComponent(components?.health, 'health'),
  })
}

function initialBudgetComponents(
  options: SwarmConcurrencyPolicyOptions,
): Readonly<Record<SwarmBudgetComponentName, number | undefined>> {
  const direct: SwarmBudgetComponents = {
    cpu: options.cpuBudget ?? options.cpu,
    memory: options.memoryBudget ?? options.memory,
    rate: options.rateBudget ?? options.rate,
    token: options.tokenBudget ?? options.token,
    health: options.healthBudget ?? options.health,
  }
  return normalizeBudgetComponents({
    ...direct,
    ...options.limits,
    ...options.components,
    ...options.budgetComponents,
  })
}

function calculateEffectiveBudget(
  configuredBudget: number,
  components: Readonly<
    Record<SwarmBudgetComponentName, number | undefined>
  >,
): number {
  let effective = configuredBudget
  for (const component of SWARM_BUDGET_COMPONENTS) {
    const limit = components[component]
    if (limit !== undefined) effective = Math.min(effective, limit)
  }
  return effective
}

/**
 * Resolves EffortValue to scheduler cost. The six VEXZY worker levels retain
 * their distinct weights; numeric/leader-only values fall back to medium.
 */
export function getSwarmWorkerWeight(
  effort: SwarmEffort | undefined,
): number {
  if (effort === undefined) return SWARM_EFFORT_WEIGHTS.medium
  if (typeof effort === 'number') {
    if (!Number.isFinite(effort)) {
      throw new Error('numeric worker effort must be finite')
    }
    if (effort <= 50) return SWARM_EFFORT_WEIGHTS.low
    if (effort <= 85) return SWARM_EFFORT_WEIGHTS.medium
    if (effort <= 95) return SWARM_EFFORT_WEIGHTS.high
    if (effort <= 100) return SWARM_EFFORT_WEIGHTS.xhigh
    return SWARM_EFFORT_WEIGHTS.max
  }
  return (
    SWARM_EFFORT_WEIGHTS[effort as keyof typeof SWARM_EFFORT_WEIGHTS] ??
    SWARM_EFFORT_WEIGHTS.medium
  )
}

function normalizeAcquireOptions(
  effortOrOptions: SwarmEffort | SwarmWorkerAcquireOptions | AbortSignal | undefined,
  signalOrWeight: AbortSignal | number | undefined,
  signal: AbortSignal | undefined,
): { effort: SwarmEffort; weight: number; signal?: AbortSignal } {
  if (isAbortSignal(effortOrOptions)) {
    return {
      effort: 'medium',
      weight: getSwarmWorkerWeight('medium'),
      signal: effortOrOptions,
    }
  }

  const options =
    typeof effortOrOptions === 'object' && effortOrOptions !== null
      ? effortOrOptions
      : undefined
  const effort =
    options?.effort ??
    (typeof effortOrOptions === 'object' ? 'medium' : effortOrOptions) ??
    'medium'
  const positionalWeight =
    typeof signalOrWeight === 'number' ? signalOrWeight : undefined
  const weight = validateWeight(
    options?.weight ?? positionalWeight ?? getSwarmWorkerWeight(effort),
  )

  return {
    effort,
    weight,
    signal:
      options?.signal ??
      (isAbortSignal(signalOrWeight) ? signalOrWeight : signal),
  }
}

export class AdaptiveSwarmConcurrencyPolicy {
  private readonly leases = new Map<string, ActiveLease>()
  private readonly waiters: Waiter[] = []
  private nextLeaseId = 0
  private activeWeight = 0
  private queuedWeight = 0
  private configuredBudget: number
  private effectiveBudget: number
  private budgetComponents: Readonly<
    Record<SwarmBudgetComponentName, number | undefined>
  >
  private pendingUpscaleBudget: number | undefined
  private stableUpscaleWindows = 0
  private readonly now: () => number
  private readonly agingWindowMs: number
  private blockedHeadBypasses = 0

  constructor(
    budgetOrOptions: number | SwarmConcurrencyPolicyOptions = {},
  ) {
    const options =
      typeof budgetOrOptions === 'number' ? undefined : budgetOrOptions
    const configuredBudget =
      typeof budgetOrOptions === 'number'
        ? budgetOrOptions
        : options?.configuredBudget ??
          options?.costBudget ??
          options?.budget ??
          getConfiguredSwarmWorkerBudget(options?.env, options?.onWarning)

    this.configuredBudget = validateBudget(configuredBudget)
    this.budgetComponents = initialBudgetComponents(options ?? {})
    this.effectiveBudget = calculateEffectiveBudget(
      this.configuredBudget,
      this.budgetComponents,
    )
    this.now = options?.now ?? Date.now
    this.agingWindowMs = options?.agingWindowMs ?? DEFAULT_AGING_WINDOW_MS
    if (!Number.isFinite(this.agingWindowMs) || this.agingWindowMs < 0) {
      throw new Error('aging window must be a finite non-negative number')
    }
  }

  /** Current effective budget, including all known resource ceilings. */
  getEffectiveBudget(): number {
    return this.effectiveBudget
  }

  /**
   * Replace the known resource observation and count one stability window.
   * Downscales apply immediately; an unchanged higher target applies after two
   * consecutive observations.
   */
  observeBudgetWindow(components?: SwarmBudgetComponents): number {
    if (components !== undefined) {
      this.budgetComponents = normalizeBudgetComponents(components)
    }
    return this.recomputeEffectiveBudget()
  }

  /** Merge a partial resource update into the current observation. */
  updateBudgetComponents(components: SwarmBudgetComponents): number {
    this.budgetComponents = normalizeBudgetComponents({
      ...this.budgetComponents,
      ...components,
    })
    return this.recomputeEffectiveBudget()
  }

  setBudgetComponents(components: SwarmBudgetComponents): number {
    return this.observeBudgetWindow(components)
  }

  updateBudgetSignals(components: SwarmBudgetComponents): number {
    return this.updateBudgetComponents(components)
  }

  recordBudgetWindow(components?: SwarmBudgetComponents): number {
    return this.observeBudgetWindow(components)
  }

  setConfiguredBudget(value: number): number {
    this.configuredBudget = validateBudget(value)
    return this.recomputeEffectiveBudget()
  }

  acquire(teamName: string, signal?: AbortSignal): Promise<SwarmWorkerLease>
  acquire(
    teamName: string,
    effort: SwarmEffort,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerLease>
  acquire(
    teamName: string,
    effort: SwarmEffort,
    weight: number,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerLease>
  acquire(
    teamName: string,
    options: SwarmWorkerAcquireOptions,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerLease>
  acquire(
    teamName: string,
    effortOrOptions: SwarmEffort | SwarmWorkerAcquireOptions | AbortSignal,
    signalOrWeight?: AbortSignal | number,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerLease>
  acquire(
    teamName: string,
    effortOrOptions: SwarmEffort | SwarmWorkerAcquireOptions | AbortSignal =
      'medium',
    signalOrWeight?: AbortSignal | number,
    signal?: AbortSignal,
  ): Promise<SwarmWorkerLease> {
    let request: ReturnType<typeof normalizeAcquireOptions>
    try {
      request = normalizeAcquireOptions(
        effortOrOptions,
        typeof signalOrWeight === 'number'
          ? signalOrWeight
          : signalOrWeight ?? signal,
        signal,
      )
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      )
    }

    if (request.signal?.aborted) {
      return Promise.reject(new Error(ABORTED_MESSAGE))
    }
    if (request.weight > this.effectiveBudget) {
      return Promise.reject(
        new Error(
          `worker lease weight ${request.weight} exceeds effective cost budget ${this.effectiveBudget}`,
        ),
      )
    }

    return new Promise<SwarmWorkerLease>((resolve, reject) => {
      const waiter: Waiter = {
        teamName,
        effort: request.effort,
        weight: request.weight,
        queuedAt: this.readNow(),
        resolve,
        reject,
        signal: request.signal,
      }

      if (waiter.signal) {
        waiter.onAbort = () => {
          const index = this.waiters.indexOf(waiter)
          if (index === -1) return

          const wasHead = index === 0
          this.waiters.splice(index, 1)
          this.queuedWeight -= waiter.weight
          this.removeAbortListener(waiter)
          if (wasHead) this.blockedHeadBypasses = 0
          reject(new Error(ABORTED_MESSAGE))
          this.drain()
        }
        waiter.signal.addEventListener('abort', waiter.onAbort, { once: true })
      }

      this.waiters.push(waiter)
      this.queuedWeight += waiter.weight
      this.drain()
    })
  }

  release(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease) return false

    this.leases.delete(leaseId)
    this.activeWeight -= lease.weight
    if (this.activeWeight < 0) this.activeWeight = 0
    this.drain()
    return true
  }

  snapshot(): SwarmConcurrencySnapshot {
    return {
      activeWorkers: this.leases.size,
      queuedRequests: this.waiters.length,
      demand: this.leases.size + this.waiters.length,
      activeWeight: this.activeWeight,
      queuedWeight: this.queuedWeight,
      budget: this.effectiveBudget,
      configuredBudget: this.configuredBudget,
      effectiveBudget: this.effectiveBudget,
      availableWeight: Math.max(0, this.effectiveBudget - this.activeWeight),
      budgetComponents: this.budgetComponents,
      pendingUpscaleBudget: this.pendingUpscaleBudget,
      stableUpscaleWindows: this.stableUpscaleWindows,
      blockedHeadBypasses: this.blockedHeadBypasses,
    }
  }

  reset(): void {
    for (const waiter of this.waiters.splice(0)) {
      this.removeAbortListener(waiter)
      waiter.reject(new Error(RESET_MESSAGE))
    }
    this.queuedWeight = 0
    this.leases.clear()
    this.activeWeight = 0
    this.pendingUpscaleBudget = undefined
    this.stableUpscaleWindows = 0
    this.blockedHeadBypasses = 0
  }

  private readNow(): number {
    const value = this.now()
    return Number.isFinite(value) ? value : 0
  }

  private recomputeEffectiveBudget(): number {
    const candidate = calculateEffectiveBudget(
      this.configuredBudget,
      this.budgetComponents,
    )

    if (candidate < this.effectiveBudget) {
      // Downscale is an immediate safety response. Existing leases are not
      // revoked, but no new lease can exceed the reduced effective budget.
      this.effectiveBudget = candidate
      this.pendingUpscaleBudget = undefined
      this.stableUpscaleWindows = 0
    } else if (candidate === this.effectiveBudget) {
      this.pendingUpscaleBudget = undefined
      this.stableUpscaleWindows = 0
    } else if (this.pendingUpscaleBudget === candidate) {
      this.stableUpscaleWindows += 1
      if (this.stableUpscaleWindows >= 2) {
        this.effectiveBudget = candidate
        this.pendingUpscaleBudget = undefined
        this.stableUpscaleWindows = 0
      }
    } else {
      this.pendingUpscaleBudget = candidate
      this.stableUpscaleWindows = 1
    }

    this.drain()
    return this.effectiveBudget
  }

  private removeAbortListener(waiter: Waiter): void {
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.onAbort = undefined
    }
  }

  private hasAged(waiter: Waiter): boolean {
    return this.readNow() - waiter.queuedAt >= this.agingWindowMs
  }

  private dispatch(index: number): void {
    const waiter = this.waiters.splice(index, 1)[0]
    if (!waiter) return

    this.queuedWeight -= waiter.weight
    this.activeWeight += waiter.weight
    this.removeAbortListener(waiter)

    const leaseId = `swarm-worker-${++this.nextLeaseId}`
    this.leases.set(leaseId, {
      teamName: waiter.teamName,
      effort: waiter.effort,
      weight: waiter.weight,
    })

    let released = false
    const lease: SwarmWorkerLease = {
      leaseId,
      teamName: waiter.teamName,
      effort: waiter.effort,
      weight: waiter.weight,
      release: () => {
        if (released) return false
        released = true
        return this.release(leaseId)
      },
    }
    waiter.resolve(lease)
  }

  private drain(): void {
    while (this.waiters.length > 0) {
      const head = this.waiters[0]
      if (!head) break

      if (head.signal?.aborted) {
        this.waiters.shift()
        this.queuedWeight -= head.weight
        this.removeAbortListener(head)
        this.blockedHeadBypasses = 0
        head.reject(new Error(ABORTED_MESSAGE))
        continue
      }

      const available = this.effectiveBudget - this.activeWeight
      if (head.weight <= available) {
        this.dispatch(0)
        this.blockedHeadBypasses = 0
        continue
      }

      // FIFO remains the default. A later request may fit only while the head
      // is not aged and has received fewer than two bounded bypasses. Once the
      // bound or age gate is reached, the head has exclusive priority.
      if (
        this.blockedHeadBypasses >= MAX_FIT_BYPASSES ||
        this.hasAged(head)
      ) {
        break
      }

      const fittingIndex = this.waiters.findIndex(
        (waiter, index) => index > 0 && waiter.weight <= available,
      )
      if (fittingIndex === -1) break

      this.blockedHeadBypasses += 1
      this.dispatch(fittingIndex)
    }
  }
}

const defaultPolicy = new AdaptiveSwarmConcurrencyPolicy()

export function acquireSwarmWorkerSlot(
  teamName: string,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease>
export function acquireSwarmWorkerSlot(
  teamName: string,
  effort: SwarmEffort,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease>
export function acquireSwarmWorkerSlot(
  teamName: string,
  effort: SwarmEffort,
  weight: number,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease>
export function acquireSwarmWorkerSlot(
  teamName: string,
  options: SwarmWorkerAcquireOptions,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease>
export function acquireSwarmWorkerSlot(
  teamName: string,
  effortOrOptions: SwarmEffort | SwarmWorkerAcquireOptions | AbortSignal,
  signalOrWeight?: AbortSignal | number,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease>
export function acquireSwarmWorkerSlot(
  teamName: string,
  effortOrOptions: SwarmEffort | SwarmWorkerAcquireOptions | AbortSignal =
    'medium',
  signalOrWeight?: AbortSignal | number,
  signal?: AbortSignal,
): Promise<SwarmWorkerLease> {
  return defaultPolicy.acquire(teamName, effortOrOptions, signalOrWeight, signal)
}

export function releaseSwarmWorkerSlot(leaseId: string): boolean {
  return defaultPolicy.release(leaseId)
}

export function getSwarmConcurrencySnapshot(): SwarmConcurrencySnapshot {
  return defaultPolicy.snapshot()
}

export function updateSwarmBudgetComponents(
  components: SwarmBudgetComponents,
): number {
  return defaultPolicy.updateBudgetComponents(components)
}

export function observeSwarmBudgetWindow(
  components?: SwarmBudgetComponents,
): number {
  return defaultPolicy.observeBudgetWindow(components)
}

/** Test-only reset hook; no production caller should need this. */
export function resetSwarmConcurrencyPolicy(): void {
  defaultPolicy.reset()
}
