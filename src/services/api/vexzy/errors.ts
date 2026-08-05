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
  readonly requestId?: string
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

type VexzyCompatibilityKind = 'abort' | 'connection' | 'timeout'

const VEXZY_COMPATIBILITY_KIND = Symbol('vexzyCompatibilityKind')

type VexzyMarkedError = Error & {
  [VEXZY_COMPATIBILITY_KIND]?:
    | VexzyCompatibilityKind
    | readonly VexzyCompatibilityKind[]
}

/**
 * Runtime-only provider error surface consumed by MindCode. The Vexzy client
 * stays independent from third-party SDK runtime error classes.
 */
export class VexzyBaseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VexzyBaseError'
  }
}

export class APIError extends VexzyBaseError {
  readonly status: number | undefined
  readonly headers: Headers | undefined
  readonly error: unknown
  readonly request_id: string | null | undefined

  constructor(
    status: number | undefined,
    error: unknown,
    message: string | undefined,
    headers: Headers | undefined,
  ) {
    super(makeAPIErrorMessage(status, error, message))
    this.name = new.target.name
    this.status = status
    this.headers = headers
    this.error = error
    this.request_id = getRequestId(headers)
  }

  /** Compatibility with callers using the camel-case SDK field. */
  get requestID(): string | null | undefined {
    return this.request_id
  }

  /** Compatibility with native Vexzy response metadata. */
  get requestId(): string | null | undefined {
    return this.request_id
  }

  static generate(
    status: number | undefined,
    errorResponse: object | undefined,
    message: string | undefined,
    headers: Headers | undefined,
  ): APIError {
    if (status === undefined || headers === undefined) {
      return new APIConnectionError({
        message,
        cause: errorResponse,
      })
    }

    if (status === 400) {
      return new BadRequestError(status, errorResponse, message, headers)
    }
    if (status === 401) {
      return new AuthenticationError(status, errorResponse, message, headers)
    }
    if (status === 403) {
      return new PermissionDeniedError(status, errorResponse, message, headers)
    }
    if (status === 404) {
      return new NotFoundError(status, errorResponse, message, headers)
    }
    if (status === 409) {
      return new ConflictError(status, errorResponse, message, headers)
    }
    if (status === 422) {
      return new UnprocessableEntityError(
        status,
        errorResponse,
        message,
        headers,
      )
    }
    if (status === 429) {
      return new RateLimitError(status, errorResponse, message, headers)
    }
    if (status >= 500) {
      return new InternalServerError(status, errorResponse, message, headers)
    }
    return new APIError(status, errorResponse, message, headers)
  }
}

export class APIUserAbortError extends APIError {
  constructor({ message }: { message?: string } = {}) {
    super(undefined, undefined, message ?? 'Request was aborted.', undefined)
    this.name = 'APIUserAbortError'
    markVexzyCompatibilityKind(this, 'abort')
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      hasVexzyCompatibilityKind(value, 'abort') ||
      (isObjectLike(value) &&
        Object.prototype.isPrototypeOf.call(APIUserAbortError.prototype, value))
    )
  }
}

export class APIConnectionError extends APIError {
  constructor({ message, cause }: { message?: string; cause?: unknown }) {
    super(undefined, undefined, message ?? 'Connection error.', undefined)
    this.name = 'APIConnectionError'
    if (cause !== undefined) attachVexzyCause(this, cause)
    markVexzyCompatibilityKind(this, 'connection')
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      hasVexzyCompatibilityKind(value, 'connection') ||
      (isObjectLike(value) &&
        Object.prototype.isPrototypeOf.call(APIConnectionError.prototype, value))
    )
  }
}

export class APIConnectionTimeoutError extends APIConnectionError {
  constructor({ message }: { message?: string } = {}) {
    super({ message: message ?? 'Request timed out.' })
    this.name = 'APIConnectionTimeoutError'
    markVexzyCompatibilityKind(this, 'timeout')
  }

  static override [Symbol.hasInstance](value: unknown): boolean {
    return (
      hasVexzyCompatibilityKind(value, 'timeout') ||
      (isObjectLike(value) &&
        Object.prototype.isPrototypeOf.call(
          APIConnectionTimeoutError.prototype,
          value,
        ))
    )
  }
}

export class BadRequestError extends APIError {}
export class AuthenticationError extends APIError {}
export class PermissionDeniedError extends APIError {}
export class NotFoundError extends APIError {}
export class ConflictError extends APIError {}
export class UnprocessableEntityError extends APIError {}
export class RateLimitError extends APIError {}
export class InternalServerError extends APIError {}

/** Error emitted for a provider `event: error` or malformed stream payload. */
export class VexzyStreamError extends APIError {
  readonly code = 'stream' as const

  constructor(cause?: unknown) {
    super(undefined, undefined, 'Vexzy stream request failed', undefined)
    this.name = 'VexzyStreamError'
    if (cause !== undefined) attachVexzyCause(this, cause)
  }
}

export function createVexzyStreamError(cause?: unknown): VexzyStreamError {
  return new VexzyStreamError(cause)
}

export function markVexzyCompatibilityKind(
  error: Error,
  kind: VexzyCompatibilityKind,
): void {
  const marked = (error as VexzyMarkedError)[VEXZY_COMPATIBILITY_KIND]
  if (marked === kind || (Array.isArray(marked) && marked.includes(kind))) {
    return
  }

  const kinds =
    marked === undefined
      ? kind
      : Array.isArray(marked)
        ? [...marked, kind]
        : [marked, kind]
  Object.defineProperty(error, VEXZY_COMPATIBILITY_KIND, {
    configurable: true,
    enumerable: false,
    value: kinds,
    writable: false,
  })
}

function hasVexzyCompatibilityKind(
  value: unknown,
  kind: VexzyCompatibilityKind,
): boolean {
  if (!(value instanceof Error)) return false
  const marked = (value as VexzyMarkedError)[VEXZY_COMPATIBILITY_KIND]
  return marked === kind || (Array.isArray(marked) && marked.includes(kind))
}

function attachVexzyCause(target: Error, cause: unknown): void {
  if (cause === undefined) return

  const safeCause = new Error(
    cause instanceof Error ? `${cause.name || 'Error'} while contacting Vexzy` :
      'Vexzy request failed',
  )
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    Object.defineProperty(safeCause, 'code', {
      configurable: true,
      enumerable: true,
      value: cause.code,
      writable: false,
    })
  }

  Object.defineProperty(target, 'cause', {
    configurable: true,
    enumerable: false,
    value: safeCause,
    writable: true,
  })
}

function getRequestId(headers: Headers | undefined): string | null | undefined {
  return headers?.get('request-id') ?? headers?.get('x-request-id')
}

function makeAPIErrorMessage(
  status: number | undefined,
  error: unknown,
  message: string | undefined,
): string {
  let detail: string | undefined
  if (isRecord(error) && typeof error.message === 'string') {
    detail = error.message
  } else if (error !== undefined) {
    detail = undefined
  }

  const text = detail ?? message
  if (status !== undefined && text) return `${status} ${text}`
  if (status !== undefined) return `${status} status code (no body)`
  return text ?? '(no status code or body)'
}

function isObjectLike(value: unknown): value is object {
  return (
    value !== null && (typeof value === 'object' || typeof value === 'function')
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

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

export class VexzyError extends APIError {
  readonly kind: VexzyErrorKind
  readonly terminal: boolean | undefined
  readonly retryable: boolean | undefined
  readonly maxRetries: number | undefined
  readonly retryAfterMs: number | undefined

  constructor(
    classification: VexzyErrorClassification,
    headers?: Headers,
  ) {
    super(
      classification.status,
      undefined,
      getSafeErrorMessage(classification),
      headers,
    )
    this.name = 'VexzyError'
    this.kind = classification.kind
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
      ...(this.request_id !== undefined &&
        this.request_id !== null && { requestId: this.request_id }),
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
  return new VexzyError(
    classifyVexzyResponse(response, now),
    new Headers(response.headers),
  )
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
