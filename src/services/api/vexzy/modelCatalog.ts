import {
  type VexzyModelLoadOptions,
  type VexzyModelRequestOptions,
  type VexzyModelSnapshot,
  createVexzyModelClient,
} from './modelClient.js'
import type { VexzyCapabilities, VexzyModel, VexzyModelRegistry } from './modelRegistry.js'

export interface VexzyModelCatalogOption {
  readonly value: string
  readonly label: string
  readonly description: string
  readonly descriptionForModel: string
  readonly displayName: string
  readonly contextLength: number
  readonly supportedReasoningEfforts: readonly string[]
  readonly available: boolean
  readonly disabled: boolean
  readonly unavailable: boolean
}

export interface VexzyModelCatalogClient {
  getModels(options?: VexzyModelLoadOptions): Promise<VexzyModelRegistry>
  refresh(options?: VexzyModelRequestOptions): Promise<VexzyModelRegistry>
  getSnapshot(): VexzyModelSnapshot | undefined
}

export type VexzyModelCatalogState =
  | 'uninitialized'
  | 'loading'
  | 'ready'
  | 'error'

export interface VexzyModelCatalogStateSnapshot {
  readonly state: VexzyModelCatalogState
  /** The registry is present only while the catalog is ready. */
  readonly registry: VexzyModelRegistry | undefined
  /** Explicit stale metadata retained while loading or after an error. */
  readonly lastRegistry: VexzyModelRegistry | undefined
  readonly error: unknown | undefined
}

export type VexzyModelCatalogListener = (
  state: VexzyModelCatalogStateSnapshot,
) => void

export function toVexzyModelCatalogOption(
  model: VexzyModel,
): VexzyModelCatalogOption {
  const availability = model.available ? 'available' : 'unavailable'
  const efforts = model.supportedReasoningEfforts.join(', ')

  return {
    value: model.id,
    label: model.displayName,
    description: `${model.id} · ${model.contextLength.toLocaleString()} context · ${availability}`,
    descriptionForModel: `${model.displayName} (${model.id}) · ${model.contextLength.toLocaleString()} context tokens · reasoning: ${efforts || 'none'}`,
    displayName: model.displayName,
    contextLength: model.contextLength,
    supportedReasoningEfforts: model.supportedReasoningEfforts,
    available: model.available,
    disabled: !model.available,
    unavailable: !model.available,
  }
}

export function getVexzyModelCatalogOptions(
  registry: VexzyModelRegistry | undefined,
): VexzyModelCatalogOption[] {
  return registry?.models.map(toVexzyModelCatalogOption) ?? []
}

export class VexzyModelCatalog {
  private lastSnapshot: VexzyModelSnapshot | undefined
  private stateValue: VexzyModelCatalogState = 'uninitialized'
  private lastError: unknown | undefined
  private readonly listeners = new Set<VexzyModelCatalogListener>()
  private inFlight: Promise<VexzyModelRegistry> | undefined
  private generation = 0

  constructor(private readonly client: VexzyModelCatalogClient) {
    this.lastSnapshot = client.getSnapshot()
  }

  get state(): VexzyModelCatalogState {
    return this.stateValue
  }

  getState(): VexzyModelCatalogStateSnapshot {
    const lastRegistry = this.lastSnapshot?.registry
    return {
      state: this.stateValue,
      registry: this.stateValue === 'ready' ? lastRegistry : undefined,
      lastRegistry,
      error: this.lastError,
    }
  }

  subscribe(listener: VexzyModelCatalogListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get snapshot(): VexzyModelSnapshot | undefined {
    return this.lastSnapshot ?? this.client.getSnapshot()
  }

  /** The registry is intentionally unavailable until the state is ready. */
  get registry(): VexzyModelRegistry | undefined {
    return this.stateValue === 'ready' ? this.lastSnapshot?.registry : undefined
  }

  /** Stale registry metadata, including while loading or after an error. */
  get lastRegistry(): VexzyModelRegistry | undefined {
    return this.lastSnapshot?.registry
  }

  getOptions(): VexzyModelCatalogOption[] {
    return getVexzyModelCatalogOptions(this.registry)
  }

  requireRegistry(): VexzyModelRegistry {
    const registry = this.registry
    if (registry === undefined) {
      throw new Error(
        `Vexzy model catalog is not ready (state: ${this.stateValue})`,
      )
    }
    return registry
  }

  getModelById(id: string): VexzyModel | undefined {
    return this.registry?.get(id)
  }

  isModelAvailable(id: string): boolean {
    return this.getModelById(id)?.available === true
  }

  getModelCapabilities(id: string): VexzyCapabilities | undefined {
    return this.getModelById(id)?.capabilities
  }

  load(options: VexzyModelLoadOptions = {}): Promise<VexzyModelRegistry> {
    return this.beginLoad(() => this.client.getModels(options))
  }

  refresh(
    options: VexzyModelRequestOptions = {},
  ): Promise<VexzyModelRegistry> {
    return this.beginLoad(() => this.client.refresh(options))
  }

  reset(): void {
    this.generation += 1
    this.inFlight = undefined
    this.lastSnapshot = undefined
    this.lastError = undefined
    this.stateValue = 'uninitialized'
    this.listeners.clear()
  }

  private beginLoad(
    start: () => Promise<VexzyModelRegistry>,
  ): Promise<VexzyModelRegistry> {
    if (this.inFlight !== undefined) return this.inFlight

    const operationGeneration = this.generation
    let resolveOperation: (registry: VexzyModelRegistry) => void = () => {}
    let rejectOperation: (error: unknown) => void = () => {}
    const operation = new Promise<VexzyModelRegistry>((resolve, reject) => {
      resolveOperation = resolve
      rejectOperation = reject
    })
    this.inFlight = operation
    this.transition('loading')

    if (operationGeneration !== this.generation) {
      rejectOperation(new Error('Vexzy model catalog was reset'))
      return operation
    }

    let request: Promise<VexzyModelRegistry>
    try {
      request = start()
    } catch (error) {
      this.finishFailure(operation, operationGeneration, error, rejectOperation)
      return operation
    }

    void request.then(
      registry => {
        if (operationGeneration === this.generation) {
          this.remember(registry)
          this.lastError = undefined
          this.transition('ready')
        }
        if (this.inFlight === operation) this.inFlight = undefined
        resolveOperation(registry)
      },
      error => {
        this.finishFailure(operation, operationGeneration, error, rejectOperation)
      },
    )

    return operation
  }

  private finishFailure(
    operation: Promise<VexzyModelRegistry>,
    operationGeneration: number,
    error: unknown,
    rejectOperation: (error: unknown) => void,
  ): void {
    if (operationGeneration === this.generation) {
      this.lastError = error
      this.transition('error')
    }
    if (this.inFlight === operation) this.inFlight = undefined
    rejectOperation(error)
  }

  private transition(nextState: VexzyModelCatalogState): void {
    if (this.stateValue === nextState) return
    this.stateValue = nextState
    const snapshot = this.getState()
    for (const listener of [...this.listeners]) listener(snapshot)
  }

  private remember(registry: VexzyModelRegistry): void {
    this.lastSnapshot =
      this.client.getSnapshot() ??
      ({ registry, fetchedAt: Date.now() } satisfies VexzyModelSnapshot)
  }
}

let defaultCatalog: VexzyModelCatalog | undefined

export function createVexzyModelCatalog(
  client: VexzyModelCatalogClient = createVexzyModelClient(),
): VexzyModelCatalog {
  return new VexzyModelCatalog(client)
}

export function configureVexzyModelCatalog(
  client: VexzyModelCatalogClient,
): VexzyModelCatalog {
  defaultCatalog?.reset()
  defaultCatalog = new VexzyModelCatalog(client)
  return defaultCatalog
}

export function resetVexzyModelCatalog(): void {
  defaultCatalog?.reset()
  defaultCatalog = undefined
}

export function getDefaultVexzyModelCatalog(): VexzyModelCatalog {
  if (defaultCatalog === undefined) {
    defaultCatalog = createVexzyModelCatalog()
  }
  return defaultCatalog
}

export function getVexzyModelCatalogState(): VexzyModelCatalogStateSnapshot {
  return getDefaultVexzyModelCatalog().getState()
}

export function subscribeVexzyModelCatalog(
  listener: VexzyModelCatalogListener,
): () => void {
  return getDefaultVexzyModelCatalog().subscribe(listener)
}

/** Synchronous compatibility read from the most recent successful snapshot. */
export function getVexzyModelRegistry(): VexzyModelRegistry | undefined {
  return defaultCatalog?.registry
}

/** Synchronous compatibility read for existing model-picker callers. */
export function getVexzyModelOptions(): VexzyModelCatalogOption[] {
  return defaultCatalog?.getOptions() ?? []
}

export function requireVexzyModelCatalog(): VexzyModelRegistry {
  return getDefaultVexzyModelCatalog().requireRegistry()
}

export function getVexzyModelById(id: string): VexzyModel | undefined {
  return getDefaultVexzyModelCatalog().getModelById(id)
}

export function isVexzyCatalogModelAvailable(id: string): boolean {
  return getVexzyModelById(id)?.available === true
}

export function getVexzyModelCapabilities(
  id: string,
): VexzyCapabilities | undefined {
  return getVexzyModelById(id)?.capabilities
}

export async function loadVexzyModelCatalog(
  options: VexzyModelLoadOptions = {},
): Promise<VexzyModelRegistry> {
  return getDefaultVexzyModelCatalog().load(options)
}

export async function refreshVexzyModelCatalog(
  options: VexzyModelRequestOptions = {},
): Promise<VexzyModelRegistry> {
  return getDefaultVexzyModelCatalog().refresh(options)
}

export const loadVexzyModelRegistry = loadVexzyModelCatalog
export const refreshVexzyModelRegistry = refreshVexzyModelCatalog
