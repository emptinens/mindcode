import { describe, expect, test } from 'bun:test'
import type { WorkerReport } from './workerReport.js'
import {
  deriveWorkerReportId,
  persistValidatedWorkerReport,
} from './workerReport.js'

function resultWith(report: WorkerReport): { workerReport: WorkerReport } {
  return { workerReport: report }
}

const validReport: WorkerReport = {
  schema_version: 'worker-report/1',
  task_id: 'task-order',
  run_id: 'run-order',
  worker_id: 'worker-order',
  report_id: deriveWorkerReportId('task-order', 'run-order', 'worker-order'),
  model: 'gpt-5.6-luna',
  effort_used: 'medium',
  policy_epoch: 0,
  policy_digest: 'a'.repeat(64),
  status: 'completed',
  summary: 'Validated report persisted before completion.',
  changed_files: [],
  evidence: [],
  tokens_used: 1,
  validation: { verdict: 'pass' },
  blockers: [],
}
const expectedPolicy = {
  policyEpoch: validReport.policy_epoch,
  policyDigest: validReport.policy_digest,
}

describe('WorkerReport completion boundary', () => {
  test('persists validated report before marking the task completed', () => {
    const events: string[] = []
    const accepted = persistValidatedWorkerReport(resultWith(validReport), {
      persist: () => events.push('persist'),
      complete: () => events.push('complete'),
      reject: () => events.push('reject'),
    }, expectedPolicy)

    expect(accepted).toBe(true)
    expect(events).toEqual(['persist', 'complete'])
  })

  test('never marks a malformed/partial report completed', () => {
    const events: string[] = []
    const accepted = persistValidatedWorkerReport(
      resultWith({
        ...validReport,
        status: 'partial',
        validation: { verdict: 'fail' },
        blockers: ['worker_report_invalid'],
      }),
      {
        persist: () => events.push('persist'),
        complete: () => events.push('complete'),
        reject: () => events.push('reject'),
      },
      expectedPolicy,
    )

    expect(accepted).toBe(false)
    expect(events).toEqual(['reject'])
  })

  test('rejects a valid-shaped report when the expected policy does not match', () => {
    const events: string[] = []
    const accepted = persistValidatedWorkerReport(resultWith(validReport), {
      persist: () => events.push('persist'),
      complete: () => events.push('complete'),
      reject: () => events.push('reject'),
    }, {
      policyEpoch: expectedPolicy.policyEpoch + 1,
      policyDigest: 'b'.repeat(64),
    })

    expect(accepted).toBe(false)
    expect(events).toEqual(['reject'])
  })
})
