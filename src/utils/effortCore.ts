export type CoreEffortLevel =
  | 'none'
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'auto'
export type CoreEffortValue = CoreEffortLevel | number

export function modelSupportsMaxEffortCore(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.includes('opus-5') ||
    normalized.includes('opus-4-8') ||
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4-6')
  )
}

export function modelSupportsXhighEffortCore(model: string): boolean {
  const normalized = model.toLowerCase()
  return (
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4-8') ||
    normalized.includes('opus-5')
  )
}

export function resolveAppliedEffort(
  model: string,
  effort: CoreEffortValue | undefined,
  supportsMax: (model: string) => boolean = modelSupportsMaxEffortCore,
  supportsXhigh: (model: string) => boolean = modelSupportsXhighEffortCore,
): CoreEffortValue | undefined {
  if (effort === 'max' && !supportsMax(model)) return 'high'
  if (effort === 'xhigh' && !supportsXhigh(model)) return 'high'
  return effort
}

export function isPersistableEffort(value: unknown): value is CoreEffortLevel {
  return (
    value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max' ||
    value === 'auto'
  )
}
