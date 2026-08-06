import { expect, test } from 'bun:test'
import { getPaneTeammateTerminalPatch } from './lifecyclePolicy.js'

test('pane exit produces a terminal /tasks state patch', () => {
  expect(
    getPaneTeammateTerminalPatch(
      {
        id: 'task-1',
        type: 'in_process_teammate',
        status: 'running',
        startTime: 123,
        identity: { agentId: 'worker@team' },
      },
      {
        taskKey: 'task-key-1',
        taskId: 'task-1',
        startTime: 123,
        agentId: 'worker@team',
      },
      'completed',
      123,
    ),
  ).toEqual({ status: 'completed', endTime: 123, isIdle: false })
})

test('terminal and unrelated tasks remain untouched', () => {
  expect(
    getPaneTeammateTerminalPatch(
      {
        id: 'task-1',
        type: 'in_process_teammate',
        status: 'killed',
        startTime: 123,
        identity: { agentId: 'worker@team' },
      },
      {
        taskKey: 'task-key-1',
        taskId: 'task-1',
        startTime: 123,
        agentId: 'worker@team',
      },
      'completed',
    ),
  ).toBeUndefined()
})

test('a different task generation is never terminalized', () => {
  expect(
    getPaneTeammateTerminalPatch(
      {
        id: 'new-task',
        type: 'in_process_teammate',
        status: 'running',
        startTime: 200,
        identity: { agentId: 'worker@team' },
      },
      {
        taskKey: 'task-key-1',
        taskId: 'old-task',
        startTime: 100,
        agentId: 'worker@team',
      },
      'failed',
    ),
  ).toBeUndefined()
})
