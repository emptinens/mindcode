import { describe, expect, test } from 'bun:test'
import {
  buildDeepLink,
  DEEP_LINK_PROTOCOL,
  parseDeepLink,
} from './parseDeepLink.js'

describe('MindCode deep links', () => {
  test('uses the MindCode protocol namespace', () => {
    expect(DEEP_LINK_PROTOCOL).toBe('mindcode')
    expect(buildDeepLink({ query: 'continue' })).toBe(
      'mindcode://open?q=continue',
    )
  })

  test('round-trips supported fields', () => {
    const link = buildDeepLink({
      query: 'fix tests',
      cwd: '/tmp/project',
      repo: 'owner/repo',
    })

    expect(parseDeepLink(link)).toEqual({
      query: 'fix tests',
      cwd: '/tmp/project',
      repo: 'owner/repo',
    })
  })
})
