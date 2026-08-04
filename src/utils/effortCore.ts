export type CoreEffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type CoreEffortValue = CoreEffortLevel | number

function isVexzyModel(model: string): boolean {
  const normalized = model.trim().toLowerCase().replace(/\[1m\]$/i, '')
  return (
    normalized.startsWith('gpt-5.6-') ||
    normalized === 'claude-opus-5' ||
    normalized === 'claude-sonnet-5'
  )
}

export function modelSupportsMaxEffortCore(model: string): boolean {
  if (isVexzyModel(model)) return true
  const normalized = model.toLowerCase()
  return (
    normalized.includes('opus-5') ||
    normalized.includes('opus-4-8') ||
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4-6')
  )
}

export function modelSupportsXhighEffortCore(model: string): boolean {
  if (isVexzyModel(model)) return true
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
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
  )
}
