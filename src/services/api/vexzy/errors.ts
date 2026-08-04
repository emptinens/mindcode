export type VexzyErrorKind =
  | 'auth'
  | 'credits'
  | 'rate_limit'
  | 'service_unavailable'
  | 'http'

export interface VexzyErrorClassification {
  readonly kind: VexzyErrorKind
  readonly status: number
  readonly terminal?: boolean
  readonly retryable?: boolean
  readonly maxRetries?: number
  readonly retryAfterMs?: number
}

export interface VexzyLoggableError {
  readonly name: 'VexzyError' | 'VexzyConfigurationError'
  readonly kind?: VexzyErrorKind
  readonly status?: number
  readonly terminal?: boolean
  readonly retryable?: boolean
  readonly retryAfterMs?: number
}

export const VEXZY_MAX_RETRIES = 3
export const VEXZY_MAX_503_RETRIES = 3
export const VEXZY_RETRY_BASE_DELAY_MS = 500
export const VEXZY_RETRY_MAX_DELAY_MS = 30_000
export const VEXZY_INVALID_API_KEY_MESSAGE =
  'VEXZY_API_KEY must start with forge-'

const NO_RETRY = 0

export class VexzyConfigurationError extends Error {
  constructor() {
    super(VEXZY_INVALID_API_KEY_MESSAGE)
    this.name = 'VexzyConfigurationError'
  }

  toLoggableObject(): VexzyLoggableError {
    return {
      name: 'VexzyConfigurationError',
      terminal: true,
      retryable: false,
    }
  }
}

export class VexzyError extends Error {
  readonly kind: VexzyErrorKind
  readonly status: number
  readonly terminal: boolean | undefined
  readonly retryable: boolean | undefined
  readonly maxRetries: number | undefined
  readonly retryAfterMs: number | undefined

  constructor(classification: VexzyErrorClassification) {
    super(getSafeErrorMessage(classification))
    this.name = 'VexzyError'
    this.kind = classification.kind
    this.status = classification.status
    this.terminal = classification.terminal
    this.retryable = classification.retryable
    this.maxRetries = classification.maxRetries
    this.retryAfterMs = classification.retryAfterMs
  }

  toLoggableObject(): VexzyLoggableError {
    return {
      name: 'VexzyError',
      kind: this.kind,
      status: this.status,
      terminal: this.terminal,
      retryable: this.retryable,
      ...(this.retryAfterMs !== undefined && {
        retryAfterMs: this.retryAfterMs,
      }),
    }
  }
}

export function classifyVexzyStatus(
  status: number,
  retryAfterMs?: number,
): VexzyErrorClassification {
  if (status === 401) {
    return {
      kind: 'auth',
      status,
      terminal: true,
      retryable: false,
      maxRetries: NO_RETRY,
    }
  }

  if (status === 402) {
    return {
      kind: 'credits',
      status,
      terminal: true,
      retryable: false,
      maxRetries: NO_RETRY,
    }
  }

  if (status === 429) {
    return {
      kind: 'rate_limit',
      status,
      terminal: false,
      retryable: true,
      maxRetries: VEXZY_MAX_RETRIES,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    }
  }

  if (status === 503) {
    return {
      kind: 'service_unavailable',
      status,
      terminal: false,
      retryable: true,
      maxRetries: VEXZY_MAX_503_RETRIES,
      ...(retryAfterMs !== undefined && { retryAfterMs }),
    }
  }

  return {
    kind: 'http',
    status,
  }
}

export function parseVexzyRetryAfter(
  value: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined

  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000)
  }

  const timestamp = Date.parse(value)
  if (!Number.isNaN(timestamp)) {
    return Math.max(0, timestamp - now)
  }

  return undefined
}

export function getVexzyRetryAfterMs(
  headers: HeadersInit | undefined,
  now = Date.now(),
): number | undefined {
  if (!headers) return undefined
  const value = new Headers(headers).get('retry-after')
  return parseVexzyRetryAfter(value, now)
}

export function classifyVexzyResponse(
  response: Pick<Response, 'status' | 'headers'>,
  now = Date.now(),
): VexzyErrorClassification {
  return classifyVexzyStatus(
    response.status,
    getVexzyRetryAfterMs(response.headers, now),
  )
}

export function createVexzyError(
  response: Pick<Response, 'status' | 'headers'>,
  now = Date.now(),
): VexzyError {
  return new VexzyError(classifyVexzyResponse(response, now))
}

/** retryCount is the number of retries already performed, excluding the first request. */
export function shouldRetryVexzy(
  classification: Pick<VexzyErrorClassification, 'retryable' | 'maxRetries'>,
  retryCount: number,
): boolean {
  return (
    classification.retryable === true &&
    Number.isInteger(retryCount) &&
    retryCount >= 0 &&
    retryCount < (classification.maxRetries ?? 0)
  )
}

export function getVexzyRetryDelayMs(
  classification: Pick<
    VexzyErrorClassification,
    'kind' | 'retryAfterMs'
  >,
  retryCount: number,
): number {
  if (classification.retryAfterMs !== undefined) {
    return Math.min(classification.retryAfterMs, VEXZY_RETRY_MAX_DELAY_MS)
  }

  const exponentialDelay = Math.min(
    VEXZY_RETRY_BASE_DELAY_MS * 2 ** Math.max(0, retryCount),
    VEXZY_RETRY_MAX_DELAY_MS,
  )

  // A Retry-After value, when supplied, always takes precedence over this
  // deterministic exponential fallback.
  return exponentialDelay
}

function getSafeErrorMessage(classification: VexzyErrorClassification): string {
  switch (classification.kind) {
    case 'auth':
      return 'Vexzy authentication failed'
    case 'credits':
      return 'Vexzy credits are exhausted'
    case 'rate_limit':
      return 'Vexzy rate limit exceeded'
    case 'service_unavailable':
      return 'Vexzy service is unavailable'
    default:
      return `Vexzy request failed (${classification.status})`
  }
}
