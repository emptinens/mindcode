import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const source = readFileSync(
  new URL('./resumeAgent.ts', import.meta.url),
  'utf8',
)
const normalizedSource = source.replaceAll('"', "'")

test('resume acquires and settles the worker lifecycle', () => {
  expect(normalizedSource).toContain('acquireWorkerExecution')
  expect(normalizedSource).toContain('createWorkerTaskGraph')
  expect(normalizedSource).not.toContain('openTaskGraph')
  expect(normalizedSource).toContain(
    'getWorkerRuntimeScope(getSessionId(), getCwd())',
  )
  expect(normalizedSource).toContain(
    'filesTouched: priorTask?.files_touched.map(publicTarget)',
  )
  expect(normalizedSource).toContain(
    'readSet: priorTask?.read_set.map(publicTarget)',
  )
  expect(normalizedSource).toContain(
    'writeSet: priorTask?.write_set.map(publicTarget)',
  )
  expect(normalizedSource).toContain('onExecutionCompleted:')
  expect(normalizedSource).toContain(
    "settleWorkerExecution('complete', result.workerReport)",
  )
  expect(normalizedSource).toContain('onExecutionFailed:')
  expect(normalizedSource).toContain('buildLifecycleFailureReport')
  expect(normalizedSource).toContain('onExecutionReleased:')
  expect(normalizedSource).toContain("settleWorkerExecution('release')")
})

test('resume does not register a task before scheduler and graph admission', () => {
  const acquire = normalizedSource.indexOf('acquireWorkerExecution(')
  const register = normalizedSource.indexOf(
    'const agentBackgroundTask = registerAsyncAgent({',
  )

  expect(acquire).toBeGreaterThan(-1)
  expect(register).toBeGreaterThan(acquire)
  expect(normalizedSource).toContain("settleWorkerExecution('release')")
  expect(normalizedSource).toContain('killAsyncAgent(agentId, rootSetAppState)')
})

test('resume uses a new graph run after a terminal lifecycle and reuses released work', () => {
  expect(normalizedSource).toContain("task.status === 'pending'")
  expect(normalizedSource).toContain('task.id.startsWith(currentPrefix)')
  expect(normalizedSource).toContain("priorTask?.status === 'pending'")
  expect(normalizedSource).toContain('return runId')
  expect(normalizedSource).toContain(
    "isolation: resumedWorktreePath ? 'worktree' : 'shared'",
  )
  expect(normalizedSource).not.toContain('blockedBy: priorTask?.blocked_by')
})
