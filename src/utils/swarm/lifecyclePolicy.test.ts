import { expect, test } from 'bun:test'
import { getPaneTeammateTerminalPatch } from './lifecyclePolicy.js'

test('pane exit produces a terminal /tasks state patch', () => {
  expect(
    getPaneTeammateTerminalPatch(
      {
        type: 'in_process_teammate',
        status: 'running',
        identity: { agentId: 'worker@team' },
      },
      'worker@team',
      'completed',
      123,
    ),
  ).toEqual({ status: 'completed', endTime: 123, isIdle: false })
})

test('terminal and unrelated tasks remain untouched', () => {
  expect(
    getPaneTeammateTerminalPatch(
      {
        type: 'in_process_teammate',
        status: 'killed',
        identity: { agentId: 'worker@team' },
      },
      'worker@team',
      'completed',
    ),
  ).toBeUndefined()
})
