import { getVexzyModelCatalogState } from '../../services/api/vexzy/modelCatalog.js'
import { VEXZY_FIXED_WORKER_MODEL } from '../../services/api/vexzy/modelRegistry.js'
import { type EffortValue, getCatalogEffortLevels } from '../effort.js'

export type WorkerEffort =
  | 'none'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

export const WORKER_EFFORT_LEVELS = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly WorkerEffort[]

export const DEFAULT_WORKER_EFFORT: WorkerEffort = 'medium'
export type WorkerEffortInput = WorkerEffort | EffortValue

export class FixedSubagentModelUnavailableError extends Error {
  readonly code = 'FIXED_SUBAGENT_MODEL_UNAVAILABLE'

  constructor(reason: string) {
    super(`Fixed Worker model is unavailable: ${reason}`)
    this.name = 'FixedSubagentModelUnavailableError'
  }
}

export class LeaderModelUnavailableError extends Error {
  readonly code = 'LEADER_MODEL_UNAVAILABLE'

  constructor(reason: string) {
    super(`Leader model is unavailable: ${reason}`)
    this.name = 'LeaderModelUnavailableError'
  }
}

export class InvalidWorkerEffortError extends Error {
  readonly code = 'INVALID_WORKER_EFFORT'

  constructor(value: unknown) {
    const rendered =
      typeof value === 'string' ? JSON.stringify(value) : String(value)
    super(
      `Invalid Worker effort ${rendered}; expected one of ${WORKER_EFFORT_LEVELS.join(', ')}`,
    )
    this.name = 'InvalidWorkerEffortError'
  }
}

/** Public Leader model boundary: catalog-backed, user-selectable model resolution. */
export class LeaderModelResolver {
  resolveDefaultModel(): string {
    const catalog = getVexzyModelCatalogState()
    if (catalog.state !== 'ready' || catalog.registry === undefined) {
      throw new LeaderModelUnavailableError(
        `VEXZY model catalog is not ready (state: ${catalog.state})`,
      )
    }

    const model = catalog.registry.models.find(entry => entry.available)
    if (model === undefined) {
      throw new LeaderModelUnavailableError('catalog has no available model')
    }

    return model.id
  }
}

/** Public Worker model boundary: every Worker resolves to the fixed Luna model. */
export class WorkerModelResolver {
  readonly fixedModel = VEXZY_FIXED_WORKER_MODEL

  resolve(): string {
    const catalog = getVexzyModelCatalogState()
    if (catalog.state !== 'ready' || catalog.registry === undefined) {
      throw new FixedSubagentModelUnavailableError(
        `VEXZY model catalog is not ready (state: ${catalog.state})`,
      )
    }

    const model = catalog.registry.get(this.fixedModel)
    if (model === undefined) {
      throw new FixedSubagentModelUnavailableError(
        'model is absent from catalog',
      )
    }
    if (model.available !== true) {
      throw new FixedSubagentModelUnavailableError('model is not available')
    }
    if (model.tools !== true || model.capabilities.tools !== true) {
      throw new FixedSubagentModelUnavailableError(
        'model does not support tool execution',
      )
    }

    return this.fixedModel
  }
}

/** Public Worker effort boundary: validates only the six fixed Luna levels. */
export class WorkerEffortResolver {
  resolve(value: unknown): WorkerEffort {
    if (value === undefined || value === null) return DEFAULT_WORKER_EFFORT
    if (
      typeof value === 'string' &&
      (WORKER_EFFORT_LEVELS as readonly string[]).includes(value)
    ) {
      return value as WorkerEffort
    }
    throw new InvalidWorkerEffortError(value)
  }

  resolveForModel(value: unknown, model: string): WorkerEffort {
    const effort = this.resolve(value)
    if (!getCatalogEffortLevels(model).includes(effort)) {
      throw new Error(
        `Fixed Worker model ${model} does not advertise worker effort "${effort}" in the ready VEXZY catalog`,
      )
    }
    return effort
  }
}

export const leaderModelResolver = new LeaderModelResolver()
export const workerModelResolver = new WorkerModelResolver()
export const workerEffortResolver = new WorkerEffortResolver()
