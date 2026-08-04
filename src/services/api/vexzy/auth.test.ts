import { describe, expect, test } from 'bun:test'
import {
  createVexzyAuthHeaders,
  createVexzyHeaders,
  createVexzyRequestInit,
  redactVexzyHeaders,
} from './auth.js'

describe('Vexzy authentication', () => {
  const apiKey = 'forge-test-key'

  test('uses Bearer authorization', () => {
    expect(createVexzyAuthHeaders(apiKey)).toEqual({
      Authorization: 'Bearer forge-test-key',
    })
  })

  test('preserves request headers but enforces Bearer authorization', () => {
    expect(
      createVexzyHeaders(apiKey, {
        'content-type': 'application/json',
        Authorization: 'Basic wrong',
        'x-request-id': 'request-1',
      }),
    ).toEqual({
      Authorization: 'Bearer forge-test-key',
      'content-type': 'application/json',
      'x-request-id': 'request-1',
    })
  })

  test('does not put the key in diagnostic headers', () => {
    const headers = createVexzyRequestInit(apiKey, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer forge-test-key',
        'x-api-key': 'forge-legacy-key',
      },
    }).headers

    expect(redactVexzyHeaders(headers ?? {})).toEqual({
      authorization: 'Bearer [REDACTED]',
      'x-api-key': '[REDACTED]',
    })
    expect(JSON.stringify(redactVexzyHeaders(headers ?? {}))).not.toContain(
      apiKey,
    )
  })
})
