import { assertVexzyApiKey } from './config.js'

export type VexzyHeaderValue = string | undefined
export type VexzyHeaders = Record<string, string>

export function getVexzyAuthorizationHeader(apiKey: string): string {
  assertVexzyApiKey(apiKey)
  return `Bearer ${apiKey}`
}

export function createVexzyAuthHeaders(apiKey: string): VexzyHeaders {
  return {
    Authorization: getVexzyAuthorizationHeader(apiKey),
  }
}

export function createVexzyHeaders(
  apiKey: string,
  headers?: HeadersInit,
): VexzyHeaders {
  const merged = new Headers(headers)

  // Authentication is applied last so a caller cannot accidentally replace
  // the required Bearer scheme with a different Authorization value.
  const result: VexzyHeaders = {}
  merged.forEach((value, name) => {
    const normalizedName = name.toLowerCase()
    if (normalizedName !== 'authorization' && normalizedName !== 'x-api-key') {
      result[name] = value
    }
  })
  result.Authorization = getVexzyAuthorizationHeader(apiKey)
  return result
}

export function createVexzyRequestInit(
  apiKey: string,
  init: RequestInit = {},
): RequestInit {
  return {
    ...init,
    headers: createVexzyHeaders(apiKey, init.headers),
  }
}

/** Returns headers suitable for diagnostics without retaining the API key. */
export function redactVexzyHeaders(headers: HeadersInit): Record<string, string> {
  const result: Record<string, string> = {}
  new Headers(headers).forEach((value, name) => {
    const normalizedName = name.toLowerCase()
    if (normalizedName === 'authorization') {
      result[name] = 'Bearer [REDACTED]'
    } else if (normalizedName === 'x-api-key') {
      result[name] = '[REDACTED]'
    } else {
      result[name] = value
    }
  })
  return result
}
