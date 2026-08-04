import { expect, test } from 'bun:test'
import { isPersistableEffort, resolveAppliedEffort } from './effortCore.js'

test('VEXZY models preserve max effort across API resolution', () => {
  const models = [
    'gpt-5.6-luna',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'claude-sonnet-5',
    'GPT-5.6-LUNA[1M]',
    'Claude-Sonnet-5[1m]',
  ]

  for (const model of models) {
    expect(resolveAppliedEffort(model, 'max')).toBe('max')
  }
})

test('unsupported ordinary models still clamp max effort to high', () => {
  expect(resolveAppliedEffort('claude-sonnet-5-20241022', 'max')).toBe('high')
  expect(resolveAppliedEffort('haiku', 'max')).toBe('high')
})

test('max effort is a persistable level for the custom build', () => {
  expect(isPersistableEffort('max')).toBe(true)
})
