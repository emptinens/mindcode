export const HARD_WORKER_CAP = 64;
export const DEFAULT_FORECAST_BUDGET = 32;
export const DEFAULT_CRITICAL_RESERVE = 8;
export const DEFAULT_AGING_WINDOW_MS = 1_000;
export const HARD_STOP_MULTIPLIER = 2;

export type CreditsPriority = "low" | "medium" | "high" | "critical";
export type CreditsEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export const CREDITS_WEIGHTS: Readonly<Record<CreditsEffort, number>> =
  Object.freeze({
    none: 1,
    low: 1,
    medium: 2,
    high: 4,
    xhigh: 6,
    max: 8,
  });

export type CreditsRequest = {
  id: string;
  priority?: CreditsPriority;
  effort?: CreditsEffort;
  weight?: number;
  estimatedCost?: number;
};

export type CreditsPolicyOptions = {
  forecastBudget?: number;
  /** Optional explicit hard stop; defaults to forecastBudget * 2. */
  hardStopAt?: number;
  criticalReserve?: number;
  workerCap?: number;
  agingWindowMs?: number;
  now?: () => number;
};

export type CreditsSnapshot = {
  forecastBudget: number;
  hardStopAt: number;
  criticalReserve: number;
  workerCap: number;
  consumed: number;
  active: number;
  queued: number;
  estimatedActive: number;
  estimatedQueued: number;
  activeEstimated: number;
  queuedEstimated: number;
  available: number;
  /** All consumed and reserved forecast cost, including queued leases. */
  committed: number;
  /** Remaining hard-stop headroom for a future lease. */
  hardStopRemaining: number;
  /** Remaining forecast-budget headroom, excluding consumed credits. */
  forecastRemaining: number;
  stopped: boolean;
};

export type CreditsAdmission = {
  admitted: boolean;
  reason?:
    | "hard-stop"
    | "worker-cap"
    | "budget"
    | "critical-reserve"
    | "queued";
  priority: CreditsPriority;
  weight: number;
  estimatedCost: number;
};

type QueueItem = {
  request: Required<Pick<CreditsRequest, "id">> & CreditsRequest;
  priority: CreditsPriority;
  weight: number;
  estimatedCost: number;
  queuedAt: number;
  resolve: (lease: CreditsLease) => void;
  reject: (error: Error) => void;
};

type ActiveItem = {
  id: string;
  priority: CreditsPriority;
  weight: number;
  estimatedCost: number;
};

export type CreditsLease = {
  id: string;
  priority: CreditsPriority;
  weight: number;
  estimatedCost: number;
  release: (actualCost?: number) => boolean;
};

const PRIORITY: Record<CreditsPriority, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};
const MAX_NUMBER = 1e12;

function bounded(value: number, name: string, minimum = 0): number {
  if (!Number.isFinite(value) || value < minimum || value > MAX_NUMBER) {
    throw new Error(
      `${name} must be a finite number between ${minimum} and ${MAX_NUMBER}`,
    );
  }
  return value;
}

function priorityOf(value: CreditsPriority | undefined): CreditsPriority {
  return value ?? "medium";
}

function weightOf(request: CreditsRequest): number {
  const weight = request.weight ?? CREDITS_WEIGHTS[request.effort ?? "medium"];
  return bounded(weight, "worker weight", Number.MIN_VALUE);
}

function estimatedCostOf(request: CreditsRequest, weight: number): number {
  return bounded(
    request.estimatedCost ?? weight,
    "estimated cost",
    Number.MIN_VALUE,
  );
}

export class CreditsFirstPolicy {
  private readonly now: () => number;
  private readonly agingWindowMs: number;
  private readonly forecastBudget: number;
  private readonly hardStopAt: number;
  private readonly criticalReserve: number;
  private readonly workerCap: number;
  private readonly queue: QueueItem[] = [];
  private readonly activeItems = new Map<string, ActiveItem>();
  private consumed = 0;
  private estimatedActive = 0;
  private estimatedQueued = 0;
  private sequence = 0;

  constructor(options: CreditsPolicyOptions = {}) {
    this.forecastBudget = bounded(
      options.forecastBudget ?? DEFAULT_FORECAST_BUDGET,
      "forecast budget",
    );
    this.hardStopAt = bounded(
      options.hardStopAt ?? this.forecastBudget * HARD_STOP_MULTIPLIER,
      "hard stop",
    );
    if (this.hardStopAt < this.forecastBudget) {
      throw new Error(
        "hard stop must be greater than or equal to forecast budget",
      );
    }
    this.criticalReserve = Math.min(
      bounded(
        options.criticalReserve ?? DEFAULT_CRITICAL_RESERVE,
        "critical reserve",
      ),
      this.forecastBudget,
    );
    this.workerCap = Math.min(
      HARD_WORKER_CAP,
      bounded(options.workerCap ?? HARD_WORKER_CAP, "worker cap", 1),
    );
    if (!Number.isInteger(this.workerCap))
      throw new Error("worker cap must be an integer");
    this.agingWindowMs = bounded(
      options.agingWindowMs ?? DEFAULT_AGING_WINDOW_MS,
      "aging window",
    );
    this.now = options.now ?? Date.now;
  }

  /** Returns the immediate admission result without enqueuing a request. */
  canAdmit(request: CreditsRequest): CreditsAdmission {
    const normalized = this.normalize(request);
    const reason = this.blockReason(normalized);
    return reason
      ? {
          admitted: false,
          reason,
          priority: normalized.priority,
          weight: normalized.weight,
          estimatedCost: normalized.estimatedCost,
        }
      : {
          admitted: true,
          priority: normalized.priority,
          weight: normalized.weight,
          estimatedCost: normalized.estimatedCost,
        };
  }

  acquire(request: CreditsRequest): Promise<CreditsLease> {
    const normalized = this.normalize(request);
    const immediateReason = this.blockReason(normalized);
    const reason =
      immediateReason === "hard-stop"
        ? immediateReason
        : this.permanentBlockReason(normalized);
    if (reason) {
      return Promise.reject(
        new Error(`credits admission blocked by ${reason}`),
      );
    }
    return new Promise((resolve, reject) => {
      const item: QueueItem = {
        ...normalized,
        queuedAt: this.readNow(),
        resolve,
        reject,
      };
      this.queue.push(item);
      this.estimatedQueued += item.estimatedCost;
      this.drain();
    });
  }

  /** Synchronous admission for callers that do not need a waiting queue. */
  tryAcquire(request: CreditsRequest): CreditsLease | undefined {
    const normalized = this.normalize(request);
    if (this.blockReason(normalized)) return undefined;
    return this.start(normalized);
  }

  complete(id: string, actualCost?: number): boolean {
    const item = this.activeItems.get(id);
    if (!item) return false;
    this.activeItems.delete(id);
    this.estimatedActive -= item.estimatedCost;
    this.consumed += bounded(
      actualCost ?? item.estimatedCost,
      "actual cost",
      0,
    );
    this.drain();
    return true;
  }

  release(id: string, actualCost?: number): boolean {
    return this.complete(id, actualCost);
  }

  /** Record provider usage that was not attached to a scheduler lease. */
  recordConsumed(actualCost: number): number {
    this.consumed += bounded(actualCost, "actual cost", 0);
    this.drain();
    return this.consumed;
  }

  /** Compatibility alias for telemetry integrations. */
  recordConsumedCredits(actualCost: number): number {
    return this.recordConsumed(actualCost);
  }

  snapshot(): CreditsSnapshot {
    const available = Math.max(
      0,
      this.forecastBudget - this.estimatedActive - this.estimatedQueued,
    );
    const committed =
      this.consumed + this.estimatedActive + this.estimatedQueued;
    return {
      forecastBudget: this.forecastBudget,
      hardStopAt: this.hardStopAt,
      criticalReserve: this.criticalReserve,
      workerCap: this.workerCap,
      consumed: this.consumed,
      active: this.activeItems.size,
      queued: this.queue.length,
      estimatedActive: this.estimatedActive,
      estimatedQueued: this.estimatedQueued,
      activeEstimated: this.estimatedActive,
      queuedEstimated: this.estimatedQueued,
      available,
      committed,
      hardStopRemaining: Math.max(0, this.hardStopAt - committed),
      forecastRemaining: Math.max(
        0,
        this.forecastBudget - this.estimatedActive - this.estimatedQueued,
      ),
      stopped: committed >= this.hardStopAt,
    };
  }

  reset(): void {
    for (const item of this.queue.splice(0))
      item.reject(new Error("credits policy reset"));
    this.activeItems.clear();
    this.consumed = 0;
    this.estimatedActive = 0;
    this.estimatedQueued = 0;
  }

  private normalize(request: CreditsRequest): QueueItem {
    if (!request || typeof request.id !== "string" || request.id.length === 0)
      throw new Error("request id is required");
    if (
      this.activeItems.has(request.id) ||
      this.queue.some((item) => item.request.id === request.id)
    )
      throw new Error(`duplicate request id: ${request.id}`);
    const priority = priorityOf(request.priority);
    const weight = weightOf(request);
    const estimatedCost = estimatedCostOf(request, weight);
    return {
      request: { ...request },
      priority,
      weight,
      estimatedCost,
      queuedAt: 0,
      resolve: () => undefined,
      reject: () => undefined,
    };
  }

  private blockReason(item: QueueItem): CreditsAdmission["reason"] | undefined {
    // Include current reservations in the admission check. This makes the
    // hard stop atomic from the policy's perspective: a lease is never
    // admitted when consumed + active + queued + next estimate overshoots it.
    const itemIsQueued = this.queue.some(
      (queued) => queued.request.id === item.request.id,
    );
    const queuedReservations = Math.max(
      0,
      this.estimatedQueued - (itemIsQueued ? item.estimatedCost : 0),
    );
    const priorityWork =
      item.priority === "critical" || item.priority === "high";
    const projectedCommitted =
      this.consumed +
      this.estimatedActive +
      (priorityWork ? 0 : queuedReservations) +
      item.estimatedCost;
    if (projectedCommitted > this.hardStopAt) return "hard-stop";
    // The cap describes concurrently active workers. Waiting requests remain
    // observable in the queue and do not consume an execution slot.
    if (this.activeItems.size >= this.workerCap) return "worker-cap";
    if (item.estimatedCost > this.forecastBudget) return "budget";
    // Priority work may displace lower-priority queued reservations; lower
    // priority work must account for all reservations and the critical reserve.
    const projected =
      this.estimatedActive +
      (priorityWork ? 0 : queuedReservations) +
      item.estimatedCost;
    const limit = priorityWork
      ? this.forecastBudget
      : this.forecastBudget - this.criticalReserve;
    if (projected > limit)
      return item.priority === "low" || item.priority === "medium"
        ? "critical-reserve"
        : "budget";
    return undefined;
  }

  /**
   * Returns only reasons that cannot become admissible after active or queued
   * leases finish. Keeping those requests queued would leave their promises
   * pending forever because consumed credits never decrease.
   */
  private permanentBlockReason(
    item: QueueItem,
  ): "hard-stop" | "budget" | "critical-reserve" | undefined {
    if (this.consumed + item.estimatedCost > this.hardStopAt) {
      return "hard-stop";
    }
    const priorityWork =
      item.priority === "critical" || item.priority === "high";
    const limit = priorityWork
      ? this.forecastBudget
      : this.forecastBudget - this.criticalReserve;
    if (item.estimatedCost > limit) {
      return priorityWork ? "budget" : "critical-reserve";
    }
    return undefined;
  }

  private start(item: QueueItem): CreditsLease {
    this.estimatedActive += item.estimatedCost;
    const active: ActiveItem = {
      id: item.request.id,
      priority: item.priority,
      weight: item.weight,
      estimatedCost: item.estimatedCost,
    };
    this.activeItems.set(active.id, active);
    let released = false;
    return {
      id: active.id,
      priority: active.priority,
      weight: active.weight,
      estimatedCost: active.estimatedCost,
      release: (actualCost?: number) => {
        if (released) return false;
        released = true;
        return this.complete(active.id, actualCost);
      },
    };
  }

  private drain(): void {
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      const item = this.queue[index];
      if (!item) continue;
      const reason = this.permanentBlockReason(item);
      if (!reason) continue;
      this.queue.splice(index, 1);
      this.estimatedQueued -= item.estimatedCost;
      item.reject(new Error(`credits admission blocked by ${reason}`));
    }
    while (this.queue.length > 0 && this.activeItems.size < this.workerCap) {
      const index = this.nextIndex();
      if (index < 0) return;
      const item = this.queue.splice(index, 1)[0];
      if (!item) return;
      this.estimatedQueued -= item.estimatedCost;
      const reason = this.blockReason({ ...item, queuedAt: 0 });
      if (reason) {
        this.queue.splice(index, 0, item);
        this.estimatedQueued += item.estimatedCost;
        return;
      }
      item.resolve(this.start(item));
    }
  }

  private nextIndex(): number {
    const now = this.readNow();
    let best = -1;
    let bestPriority = -1;
    let bestWeight = Number.POSITIVE_INFINITY;
    let bestAge = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const item = this.queue[index];
      if (!item || this.blockReason({ ...item, queuedAt: 0 }) === "hard-stop")
        continue;
      const age = Math.max(0, now - item.queuedAt);
      const aged = age >= this.agingWindowMs;
      const priority = PRIORITY[item.priority];
      // Critical/high always outrank low/medium. Aging only orders peers and lets
      // an old lower-priority item beat a newer lower-priority item.
      const score =
        priority >= PRIORITY.high ? priority + 10 : priority + (aged ? 0.5 : 0);
      if (
        score > bestPriority ||
        (score === bestPriority &&
          ((aged && age > bestAge) || (!aged && item.weight < bestWeight)))
      ) {
        best = index;
        bestPriority = score;
        bestWeight = item.weight;
        bestAge = age;
      }
    }
    return best;
  }

  private readNow(): number {
    const value = this.now();
    return Number.isFinite(value) ? value : 0;
  }
}

export const CreditsPolicy = CreditsFirstPolicy;
