import { describe, expect, test } from 'bun:test'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  VEXZY_MAX_503_RETRIES,
  VexzyError,
  VexzyStreamError,
  classifyVexzyResponse,
  classifyVexzyStatus,
  createVexzyError,
  getVexzyRetryAfterMs,
  getVexzyRetryDelayMs,
  parseVexzyRetryAfter,
  shouldRetryVexzy,
} from './errors.js'

describe('Vexzy error policy', () => {
  test('exposes the native APIError fields without importing the SDK', () => {
    const error = createVexzyError(
      new Response(null, {
        status: 429,
        headers: {
          'request-id': 'req_native',
          'retry-after': '2',
        },
      }),
    )

    expect(error).toBeInstanceOf(APIError)
    expect(error.status).toBe(429)
    expect(error.headers).toBeInstanceOf(Headers)
    expect(error.error).toBeUndefined()
    expect(error.request_id).toBe('req_native')
    expect(error.requestID).toBe('req_native')
    expect(error.requestId).toBe('req_native')
  })

  test('marks native abort, timeout, and stream error categories', () => {
    const abort = new APIUserAbortError()
    const timeout = new APIConnectionTimeoutError()
    const connection = new APIConnectionError({ message: 'connection' })
    const stream = new VexzyStreamError()

    expect(abort).toBeInstanceOf(APIError)
    expect(abort).toBeInstanceOf(APIUserAbortError)
    expect(abort.name).toBe('APIUserAbortError')
    expect(timeout).toBeInstanceOf(APIConnectionError)
    expect(timeout).toBeInstanceOf(APIConnectionTimeoutError)
    expect(connection).toBeInstanceOf(APIConnectionError)
    expect(stream).toBeInstanceOf(APIError)
    expect(stream.code).toBe('stream')
  })

  test('classifies auth and credits failures as terminal', () => {
    expect(classifyVexzyStatus(401)).toMatchObject({
      kind: 'auth',
      terminal: true,
      retryable: false,
      maxRetries: 0,
    })
    expect(classifyVexzyStatus(402)).toMatchObject({
      kind: 'credits',
      terminal: true,
      retryable: false,
      maxRetries: 0,
    })
  })

  test('retries 429 and honors delta-seconds and HTTP-date Retry-After', () => {
    expect(parseVexzyRetryAfter('2')).toBe(2000)
    expect(parseVexzyRetryAfter('invalid')).toBeUndefined()
    expect(
      parseVexzyRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT')),
    ).toBe(60_000)

    const classification = classifyVexzyResponse(
      new Response(null, { status: 429, headers: { 'Retry-After': '7' } }),
    )
    expect(classification).toMatchObject({
      kind: 'rate_limit',
      terminal: false,
      retryable: true,
      retryAfterMs: 7000,
    })
    expect(shouldRetryVexzy(classification, 0)).toBe(true)
    expect(getVexzyRetryDelayMs(classification, 0)).toBe(7000)
    expect(
      getVexzyRetryAfterMs({ 'Retry-After': '3' }),
    ).toBe(3000)
  })

  test('bounds 503 retries', () => {
    const classification = classifyVexzyStatus(503)
    expect(classification).toMatchObject({
      kind: 'service_unavailable',
      retryable: true,
      maxRetries: VEXZY_MAX_503_RETRIES,
    })
    expect(shouldRetryVexzy(classification, VEXZY_MAX_503_RETRIES - 1)).toBe(
      true,
    )
    expect(shouldRetryVexzy(classification, VEXZY_MAX_503_RETRIES)).toBe(false)
  })

  test('does not invent semantics for undocumented statuses', () => {
    expect(classifyVexzyStatus(418)).toEqual({
      kind: 'http',
      status: 418,
    })
    expect(shouldRetryVexzy(classifyVexzyStatus(500), 0)).toBe(false)
  })

  test('bounds provider Retry-After values', () => {
    const classification = classifyVexzyStatus(429, 300_000)
    expect(getVexzyRetryDelayMs(classification, 0)).toBe(30_000)
  })

  test('error and loggable data never include the API key or response body', () => {
    const apiKey = 'forge-secret-key'
    const error = createVexzyError(
      new Response(JSON.stringify({ error: apiKey }), {
        status: 401,
        headers: { 'Retry-After': '1' },
      }),
    )

    expect(error).toBeInstanceOf(VexzyError)
    expect(error.message).not.toContain(apiKey)
    expect(JSON.stringify(error.toLoggableObject())).not.toContain(apiKey)
    expect(JSON.stringify(error.toLoggableObject())).not.toContain('error')
  })
})
