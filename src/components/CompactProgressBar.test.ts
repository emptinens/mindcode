import { describe, expect, mock, test } from 'bun:test'

mock.module('../ink.js', () => ({
  Box: () => null,
  Text: () => null,
  useAnimationFrame: () => [null],
}))

const { getCompactProgressState } = await import('./CompactProgressBar.js')

describe('compact progress', () => {
  test('reports honest elapsed time in indeterminate mode', () => {
    expect(getCompactProgressState(0)).toEqual({
      mode: 'indeterminate',
      elapsedLabel: '0s',
      indicator: '...',
    })
    expect(getCompactProgressState(60_000)).toMatchObject({
      mode: 'indeterminate',
      elapsedLabel: '60s',
    })
  })

  test('never fabricates a terminal percentage', () => {
    const serialized = JSON.stringify(getCompactProgressState(600_000))
    expect(serialized).not.toContain('%')
    expect(serialized).not.toContain('97%')
  })
})
